import { Client, GatewayIntentBits, EmbedBuilder, type TextChannel } from "discord.js";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// -- Configuration ------------------------------------------------------------

interface Config {
  botToken: string;
  feedChannelId: string;
  mercuryDbPath: string;
  cursorFilePath: string;
  pollIntervalMs: number;
  batchLimit: number;
}

function loadConfig(): Config {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    throw new Error(
      "DISCORD_BOT_TOKEN is required. Set it as an environment variable."
    );
  }

  const feedChannelId = process.env.DISCORD_FEED_CHANNEL_ID;
  if (!feedChannelId) {
    throw new Error(
      "DISCORD_FEED_CHANNEL_ID is required. Set it to the Discord channel ID where messages should be posted."
    );
  }

  return {
    botToken,
    feedChannelId,
    mercuryDbPath:
      process.env.MERCURY_DB_PATH ||
      join(homedir(), ".local", "share", "mercury", "mercury.db"),
    cursorFilePath:
      process.env.CURSOR_FILE_PATH ||
      join(homedir(), ".local", "share", "mercury", "discord-feed-cursor"),
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "2000", 10),
    batchLimit: parseInt(process.env.BATCH_LIMIT || "50", 10),
  };
}

// -- Mercury DB reader --------------------------------------------------------

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

function openMercuryDb(path: string): Database {
  const db = new Database(path, { readonly: true });
  db.exec("PRAGMA journal_mode=WAL");
  validateSchema(db);
  return db;
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

// -- Cursor persistence -------------------------------------------------------

function loadCursor(path: string): number {
  try {
    const content = readFileSync(path, "utf-8").trim();
    const n = parseInt(content, 10);
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

function saveCursor(path: string, id: number): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, String(id) + "\n", "utf-8");
  renameSync(tmpPath, path);
}

// -- Discord formatting -------------------------------------------------------

// Default colors for well-known Mercury channel conventions.
// Unknown channels get a deterministic hash-derived color.
const CHANNEL_COLORS: Record<string, number> = {
  status: 0x808080,           // gray
  studio: 0x5865f2,           // blurple
  workers: 0x57f287,          // green
  oracle: 0xe67e22,           // orange
  test: 0x95a5a6,             // light gray
};

function channelColor(channel: string): number {
  if (CHANNEL_COLORS[channel] !== undefined) {
    return CHANNEL_COLORS[channel];
  }
  // Hash-derived color for unknown channels
  let hash = 0;
  for (let i = 0; i < channel.length; i++) {
    hash = ((hash << 5) - hash + channel.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) & 0xffffff;
}

function channelEmoji(channel: string): string {
  if (channel === "status") return "\u{1F7E2}";          // green circle
  if (channel === "studio") return "\u{1F3DB}\u{FE0F}";  // classical building
  if (channel === "workers") return "\u{2692}\u{FE0F}";  // hammer and pick
  if (channel === "oracle") return "\u{1F52E}";           // crystal ball
  if (channel.startsWith("keeper:")) return "\u{1F4AC}";  // speech bubble
  return "\u{1F4AC}";                                      // speech bubble
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
  if (lastBody === msg.body) {
    return true;
  }
  lastMessageBySender.set(msg.sender, msg.body);
  return false;
}

function isCompactStatus(msg: MercuryMessage): boolean {
  return (
    msg.channel === "status" &&
    msg.body.length < 100 &&
    msg.body.toLowerCase().includes("online")
  );
}

function formatCompactStatus(msg: MercuryMessage): string {
  return `${channelEmoji(msg.channel)} **${msg.sender}** ${msg.body}`;
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

// -- Main ---------------------------------------------------------------------

async function main() {
  const config = loadConfig();
  console.log("[mercury-feed] Starting...");
  console.log(`[mercury-feed] Mercury DB: ${config.mercuryDbPath}`);
  console.log(`[mercury-feed] Cursor file: ${config.cursorFilePath}`);
  console.log(`[mercury-feed] Channel ID: ${config.feedChannelId}`);
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

  let cursor = loadCursor(config.cursorFilePath);
  console.log(`[mercury-feed] Loaded cursor: ${cursor}`);

  // Connect to Discord
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  let feedChannel: TextChannel | null = null;
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let shuttingDown = false;

  client.once("clientReady", async () => {
    console.log(`[mercury-feed] Discord connected as ${client.user?.tag}`);

    try {
      const ch = await client.channels.fetch(config.feedChannelId);
      if (!ch || !ch.isTextBased()) {
        console.error("[mercury-feed] Feed channel not found or not a text channel");
        process.exit(1);
      }
      feedChannel = ch as TextChannel;
      console.log(`[mercury-feed] Posting to #${feedChannel.name}`);
    } catch (e: any) {
      console.error(`[mercury-feed] Failed to fetch channel: ${e.message}`);
      process.exit(1);
    }

    // Startup message
    await feedChannel.send("\u{1F7E2} Mercury feed online \u2014 watching all channels");

    // Check if there's a large backlog
    const backlogMessages = pollNewMessages(db!, cursor, 1000);
    if (backlogMessages.length > 100) {
      const skipTo = backlogMessages[backlogMessages.length - 1].id;
      const oldestTs = formatTimestamp(backlogMessages[0].created_at);
      await feedChannel.send(
        `\u{1F4CB} Catching up: skipped ${backlogMessages.length} historical messages since ${oldestTs}. Starting from current.`
      );
      cursor = skipTo;
      saveCursor(config.cursorFilePath, cursor);
    }

    // Poll loop
    pollInterval = setInterval(async () => {
      if (shuttingDown || !feedChannel || !db) return;

      try {
        const messages = pollNewMessages(db, cursor, config.batchLimit);
        for (const msg of messages) {
          try {
            // Deduplicate: skip if same sender sent exact same body last time
            if (isDuplicate(msg)) {
              console.log(
                `[mercury-feed] Skipping duplicate from ${msg.sender}: "${msg.body.slice(0, 50)}..."`
              );
              cursor = msg.id;
              continue;
            }

            // Compact status messages (short "online" pings) -- plain text, no embed
            if (isCompactStatus(msg)) {
              await feedChannel.send(formatCompactStatus(msg));
            } else {
              await feedChannel.send({ embeds: [formatEmbed(msg)] });
            }
            cursor = msg.id;
          } catch (e: any) {
            console.error(
              `[mercury-feed] Failed to send message ${msg.id}: ${e.message}`
            );
            break; // Stop this batch, retry next poll
          }
        }
        if (messages.length > 0) {
          saveCursor(config.cursorFilePath, cursor);
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
    saveCursor(config.cursorFilePath, cursor);

    if (feedChannel) {
      try {
        await feedChannel.send("\u{1F534} Mercury feed offline");
      } catch {
        // Best effort
      }
    }

    client.destroy();
    if (db) db.close();
    console.log("[mercury-feed] Goodbye.");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Login
  await client.login(config.botToken);
}

main().catch((e) => {
  console.error(`[mercury-feed] Fatal: ${e.message}`);
  process.exit(1);
});
