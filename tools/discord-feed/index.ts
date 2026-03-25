import { Client, GatewayIntentBits, EmbedBuilder, type TextChannel } from "discord.js";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// ── Configuration ────────────────────────────────────────────────────

interface Config {
  botToken: string;
  fallbackChannelId: string;
  mercuryDbPath: string;
  cursorDir: string;
  pollIntervalMs: number;
  batchLimit: number;
}

interface Route {
  id: number;
  channel: string;       // Mercury channel name, or "*" for all
  destination: string;    // "discord:<channel_id>"
  config: RouteConfig;
  discordChannelId: string;
}

interface RouteConfig {
  format?: "embed" | "compact" | "plain";
}

function loadConfig(): Config {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    throw new Error(
      "DISCORD_BOT_TOKEN is required. Set it as an environment variable."
    );
  }

  const cursorDir =
    process.env.CURSOR_DIR ||
    join(homedir(), ".local", "share", "mercury", "feed-cursors");
  if (!existsSync(cursorDir)) {
    mkdirSync(cursorDir, { recursive: true });
  }

  return {
    botToken,
    fallbackChannelId: process.env.DISCORD_FEED_CHANNEL_ID || "",
    mercuryDbPath:
      process.env.MERCURY_DB_PATH ||
      join(homedir(), ".local", "share", "mercury", "mercury.db"),
    cursorDir,
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "2000", 10),
    batchLimit: parseInt(process.env.BATCH_LIMIT || "50", 10),
  };
}

// ── Mercury DB reader ────────────────────────────────────────────────

interface MercuryMessage {
  id: number;
  channel: string;
  sender: string;
  body: string;
  created_at: string;
}

function validateSchema(db: Database): void {
  const REQUIRED_COLUMNS = ["id", "channel", "sender", "body", "created_at"];
  const rows = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  const columns = new Set(rows.map((r) => r.name));

  const missing = REQUIRED_COLUMNS.filter((c) => !columns.has(c));
  if (missing.length > 0) {
    throw new Error(
      `Mercury schema mismatch: messages table is missing columns: ${missing.join(", ")}. ` +
      `See https://github.com/gudnuf/mercury/blob/main/docs/SCHEMA.md`
    );
  }
}

interface RawRoute {
  id: number;
  channel: string;
  destination: string;
  config: string;
  active: number;
}

function openMercuryDb(path: string): Database {
  const db = new Database(path, { readonly: true });
  db.exec("PRAGMA journal_mode=WAL");
  validateSchema(db);
  return db;
}

function loadRoutes(db: Database): Route[] {
  try {
    const rows = db.prepare(
      "SELECT id, channel, destination, config FROM routes WHERE active = 1 AND destination LIKE 'discord:%'"
    ).all() as RawRoute[];

    return rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      destination: r.destination,
      config: JSON.parse(r.config || "{}") as RouteConfig,
      discordChannelId: r.destination.replace(/^discord:/, ""),
    }));
  } catch {
    // Routes table might not exist yet
    return [];
  }
}

function matchingRoutes(routes: Route[], msgChannel: string): Route[] {
  return routes.filter((r) => r.channel === "*" || r.channel === msgChannel);
}

function pollNewMessages(
  db: Database,
  lastId: number,
  limit: number
): MercuryMessage[] {
  const stmt = db.prepare(
    "SELECT id, channel, sender, body, created_at FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?"
  );
  return stmt.all(lastId, limit) as MercuryMessage[];
}

// ── Cursor persistence (per-route) ──────────────────────────────────

function cursorPath(dir: string, routeId: string): string {
  return join(dir, `cursor-${routeId}`);
}

function loadCursor(dir: string, routeId: string): number {
  try {
    const content = readFileSync(cursorPath(dir, routeId), "utf-8").trim();
    const n = parseInt(content, 10);
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

function saveCursor(dir: string, routeId: string, id: number): void {
  const p = cursorPath(dir, routeId);
  const tmpPath = p + ".tmp";
  writeFileSync(tmpPath, String(id) + "\n", "utf-8");
  renameSync(tmpPath, p);
}

// Migrate old single-cursor file to per-route cursor
function migrateOldCursor(cursorDir: string, routeId: string): void {
  const oldPath = process.env.CURSOR_FILE_PATH ||
    join(dirname(cursorDir), "discord-feed-cursor");
  try {
    const content = readFileSync(oldPath, "utf-8").trim();
    const n = parseInt(content, 10);
    if (!isNaN(n) && n > 0) {
      const existing = loadCursor(cursorDir, routeId);
      if (existing === 0) {
        saveCursor(cursorDir, routeId, n);
        console.log(`[mercury-feed] Migrated old cursor (${n}) to route ${routeId}`);
      }
    }
  } catch {
    // No old cursor file, nothing to migrate
  }
}

// ── Discord formatting ───────────────────────────────────────────────

const CHANNEL_COLORS: Record<string, number> = {
  status: 0x808080,           // gray
  studio: 0x5865f2,           // blurple
  workers: 0x57f287,          // green
  oracle: 0xe67e22,           // orange
  "keeper:feedback": 0xfee75c, // yellow
  "keeper:murmur": 0xeb459e,   // pink
  test: 0x95a5a6,             // light gray
};

function channelColor(channel: string): number {
  if (CHANNEL_COLORS[channel] !== undefined) {
    return CHANNEL_COLORS[channel];
  }
  let hash = 0;
  for (let i = 0; i < channel.length; i++) {
    hash = ((hash << 5) - hash + channel.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) & 0xffffff;
}

function channelEmoji(channel: string): string {
  if (channel === "status") return "\u{1F7E2}";
  if (channel === "studio") return "\u{1F3DB}\u{FE0F}";
  if (channel === "workers") return "\u{2692}\u{FE0F}";
  if (channel === "oracle") return "\u{1F52E}";
  if (channel.startsWith("keeper:")) return "\u{1F4AC}";
  return "\u{1F4AC}";
}

function formatTimestamp(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  } catch {
    return isoString;
  }
}

function truncateBody(body: string): string {
  const MAX = 4000;
  if (body.length <= MAX) return body;
  return body.slice(0, MAX) + `\n\n... (truncated, ${body.length} chars total)`;
}

// Deduplication: track last message body per sender
const lastMessageBySender: Map<string, string> = new Map();

function isDuplicate(msg: MercuryMessage): boolean {
  const lastBody = lastMessageBySender.get(msg.sender);
  if (lastBody === msg.body) return true;
  lastMessageBySender.set(msg.sender, msg.body);
  return false;
}

function formatEmbed(msg: MercuryMessage): EmbedBuilder {
  const emoji = channelEmoji(msg.channel);
  return new EmbedBuilder()
    .setColor(channelColor(msg.channel))
    .setTitle(`${emoji} #${msg.channel}`)
    .setAuthor({ name: msg.sender })
    .setDescription(truncateBody(msg.body))
    .setFooter({ text: formatTimestamp(msg.created_at) });
}

function formatCompact(msg: MercuryMessage): string {
  const emoji = channelEmoji(msg.channel);
  return `${emoji} **#${msg.channel}** | **${msg.sender}**: ${msg.body.slice(0, 500)}`;
}

function formatPlain(msg: MercuryMessage): string {
  return `[${msg.channel}] ${msg.sender}: ${msg.body.slice(0, 1800)}`;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  console.log("[mercury-feed] Starting...");
  console.log(`[mercury-feed] Mercury DB: ${config.mercuryDbPath}`);
  console.log(`[mercury-feed] Cursor dir: ${config.cursorDir}`);
  console.log(`[mercury-feed] Fallback channel: ${config.fallbackChannelId || "(none)"}`);
  console.log(`[mercury-feed] Poll interval: ${config.pollIntervalMs}ms`);

  // Wait for Mercury DB to exist
  let db: Database | null = null;
  while (!db) {
    try {
      db = openMercuryDb(config.mercuryDbPath);
      console.log("[mercury-feed] Mercury DB opened (read-only)");
    } catch (e: any) {
      console.error(
        `[mercury-feed] Mercury DB not available: ${e.message}. Retrying in 10s...`
      );
      await new Promise((r) => setTimeout(r, 10000));
    }
  }

  // Load routes from DB, fall back to env var
  let routes = loadRoutes(db);
  if (routes.length === 0 && config.fallbackChannelId) {
    console.log("[mercury-feed] No routes in DB, using fallback DISCORD_FEED_CHANNEL_ID");
    routes = [{
      id: 0,
      channel: "*",
      destination: `discord:${config.fallbackChannelId}`,
      config: { format: "embed" },
      discordChannelId: config.fallbackChannelId,
    }];
  } else if (routes.length === 0) {
    throw new Error("No routes configured and no DISCORD_FEED_CHANNEL_ID fallback set");
  } else {
    console.log(`[mercury-feed] Loaded ${routes.length} route(s) from DB`);
  }

  // Migrate old cursor for each route
  for (const route of routes) {
    migrateOldCursor(config.cursorDir, String(route.id));
  }

  // Load per-route cursors
  const cursors = new Map<string, number>();
  for (const route of routes) {
    const rid = String(route.id);
    cursors.set(rid, loadCursor(config.cursorDir, rid));
    console.log(`[mercury-feed]   route ${route.id}: ${route.channel} -> ${route.destination} (cursor: ${cursors.get(rid)})`);
  }

  // Connect to Discord
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  const channelCache = new Map<string, TextChannel>();

  async function getDiscordChannel(channelId: string): Promise<TextChannel | null> {
    const cached = channelCache.get(channelId);
    if (cached) return cached;
    try {
      const ch = await client.channels.fetch(channelId);
      if (ch && ch.isTextBased()) {
        channelCache.set(channelId, ch as TextChannel);
        return ch as TextChannel;
      }
    } catch (e: any) {
      console.error(`[mercury-feed] Failed to fetch Discord channel ${channelId}: ${e.message}`);
    }
    return null;
  }

  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let shuttingDown = false;
  let routeRefreshCounter = 0;

  client.once("clientReady", async () => {
    console.log(`[mercury-feed] Discord connected as ${client.user?.tag}`);

    // Prefetch all Discord channels
    for (const route of routes) {
      const ch = await getDiscordChannel(route.discordChannelId);
      if (ch) {
        console.log(`[mercury-feed] Verified Discord channel: #${ch.name} (${route.discordChannelId})`);
      } else {
        console.error(`[mercury-feed] WARNING: Cannot access channel ${route.discordChannelId} for route ${route.id}`);
      }
    }

    // Startup message to first available channel
    const startupChannelId = config.fallbackChannelId || routes[0]?.discordChannelId;
    const startupCh = startupChannelId ? await getDiscordChannel(startupChannelId) : null;
    if (startupCh) {
      const routeDesc = routes.map((r) => `${r.channel} -> <#${r.discordChannelId}>`).join(", ");
      await startupCh.send(`\u{1F7E2} Mercury feed online \u2014 ${routes.length} route(s): ${routeDesc}`);
    }

    // Check for large backlogs per route
    for (const route of routes) {
      const rid = String(route.id);
      const cursor = cursors.get(rid) || 0;
      const backlog = pollNewMessages(db!, cursor, 1000);
      if (backlog.length > 100) {
        const skipTo = backlog[backlog.length - 1].id;
        cursors.set(rid, skipTo);
        saveCursor(config.cursorDir, rid, skipTo);
        const ch = await getDiscordChannel(route.discordChannelId);
        if (ch) {
          await ch.send(`\u{1F4CB} Catching up: skipped ${backlog.length} historical messages for route ${route.channel}. Starting from current.`);
        }
      }
    }

    // Poll loop
    pollInterval = setInterval(async () => {
      if (shuttingDown || !db) return;

      // Refresh routes from DB every ~60s (30 cycles at 2s)
      routeRefreshCounter++;
      if (routeRefreshCounter >= 30) {
        routeRefreshCounter = 0;
        const newRoutes = loadRoutes(db);
        if (newRoutes.length > 0) {
          for (const r of newRoutes) {
            const rid = String(r.id);
            if (!cursors.has(rid)) {
              cursors.set(rid, loadCursor(config.cursorDir, rid));
              console.log(`[mercury-feed] New route detected: ${r.channel} -> ${r.destination}`);
            }
          }
          routes = newRoutes;
        }
      }

      const minCursor = Math.min(...Array.from(cursors.values()));

      try {
        const messages = pollNewMessages(db, minCursor, config.batchLimit);
        if (messages.length === 0) return;

        for (const msg of messages) {
          // Deduplicate across all routes
          const dup = isDuplicate(msg);

          const matched = matchingRoutes(routes, msg.channel);
          for (const route of matched) {
            const rid = String(route.id);
            const routeCursor = cursors.get(rid) || 0;
            if (msg.id <= routeCursor) continue;

            if (dup) {
              console.log(`[mercury-feed] Skipping duplicate from ${msg.sender} for route ${rid}`);
              cursors.set(rid, msg.id);
              continue;
            }

            const ch = await getDiscordChannel(route.discordChannelId);
            if (!ch) {
              cursors.set(rid, msg.id);
              continue;
            }

            try {
              const fmt = route.config.format || "embed";
              if (fmt === "compact") {
                await ch.send(formatCompact(msg));
              } else if (fmt === "plain") {
                await ch.send(formatPlain(msg));
              } else {
                await ch.send({ embeds: [formatEmbed(msg)] });
              }
              cursors.set(rid, msg.id);
            } catch (e: any) {
              console.error(`[mercury-feed] Failed to send msg ${msg.id} to ${route.destination}: ${e.message}`);
            }
          }
        }

        // Save all cursors
        for (const [rid, cursor] of cursors) {
          saveCursor(config.cursorDir, rid, cursor);
        }
      } catch (e: any) {
        console.error(`[mercury-feed] Poll error: ${e.message}`);
      }
    }, config.pollIntervalMs);
  });

  // Graceful shutdown
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[mercury-feed] Received ${signal}, shutting down...`);

    if (pollInterval) clearInterval(pollInterval);
    for (const [rid, cursor] of cursors) {
      saveCursor(config.cursorDir, rid, cursor);
    }

    const shutdownChannelId = config.fallbackChannelId || routes[0]?.discordChannelId;
    if (shutdownChannelId) {
      const ch = await getDiscordChannel(shutdownChannelId);
      if (ch) {
        try { await ch.send("\u{1F534} Mercury feed offline"); } catch {}
      }
    }

    client.destroy();
    if (db) db.close();
    console.log("[mercury-feed] Goodbye.");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await client.login(config.botToken);
}

main().catch((e) => {
  console.error(`[mercury-feed] Fatal: ${e.message}`);
  process.exit(1);
});
