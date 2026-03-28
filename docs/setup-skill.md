# Mercury Setup Skill

**Purpose:** Set up Mercury (inter-agent message bus) and its Claude Code MCP plugin on a new machine. This is a self-contained guide an agent can follow from scratch.

**Source repo:** https://github.com/gudnuf/mercury

---

## Step 1: Detect Environment

Run these commands and note the results. Adapt later steps accordingly.

```bash
# OS detection
uname -s          # Darwin = macOS, Linux = Linux
uname -m          # x86_64, aarch64/arm64

# NixOS check
[[ -f /etc/NIXOS ]] && echo "NixOS" || echo "Not NixOS"

# Package managers
command -v nix    && echo "Nix available"
command -v brew   && echo "Homebrew available"
command -v apt    && echo "apt available"

# Required tools
command -v go     && go version
command -v bun    && bun --version
command -v claude && claude --version
command -v jq     && echo "jq available"
command -v tmux   && echo "tmux available"
```

**Requirements:**
- **Go** (to build Mercury CLI) -- or **Nix** (preferred, builds from flake)
- **Bun** (to run the MCP plugin -- it uses `bun:sqlite`)
- **Claude Code** 2.x+ with plugin/channel support
- **jq** (used by launch scripts)
- **tmux** (for running agents in sessions)

---

## Step 2: Install Dependencies

### Bun (required for the MCP plugin)

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Nix (ephemeral)
nix shell nixpkgs#bun
```

### Go (required to build Mercury CLI, unless using Nix)

```bash
# macOS
brew install go

# Debian/Ubuntu
sudo apt install golang-go

# Nix (ephemeral)
nix shell nixpkgs#go
```

### jq and tmux

```bash
# macOS
brew install jq tmux

# Debian/Ubuntu
sudo apt install jq tmux

# Nix
nix shell nixpkgs#jq nixpkgs#tmux
```

---

## Step 3: Install Mercury CLI

Choose ONE method based on your environment.

### Method A: Nix (recommended)

```bash
# One-shot build
nix build github:gudnuf/mercury
# Binary at ./result/bin/mercury

# Or install to profile (persistent)
nix profile install github:gudnuf/mercury

# Or add as a flake input in your system config:
#   mercury.url = "github:gudnuf/mercury";
#   environment.systemPackages = [ inputs.mercury.packages.${system}.default ];
```

### Method B: Go build from source

```bash
git clone https://github.com/gudnuf/mercury.git /tmp/mercury-build
cd /tmp/mercury-build
go build -o mercury ./cmd/mercury

# Move to a directory on your PATH
sudo mv mercury /usr/local/bin/
# Or: mv mercury ~/.local/bin/  (if ~/.local/bin is on PATH)
# Or: mv mercury ~/forge/tools/  (if ~/forge/tools is on PATH)
```

### Method C: Nix dev shell (temporary)

```bash
cd /tmp
git clone https://github.com/gudnuf/mercury.git
cd mercury
nix develop  # drops you into a shell with Go + SQLite
go build -o mercury ./cmd/mercury
mv mercury ~/.local/bin/
```

### Verify Mercury CLI

```bash
mercury --help
# Should show: send, read, subscribe, channels, log, etc.

# Test it works (creates DB at ~/.local/share/mercury/mercury.db)
mercury send --as "setup-test" --to "status" "mercury installed"
mercury log --channel status
# Should show the message you just sent
```

---

## Step 4: Install Mercury MCP Plugin

The MCP plugin bridges Mercury into Claude Code as push notifications. It polls the SQLite DB and delivers messages via `notifications/claude/channel`.

### 4a: Create the forge marketplace directory

```bash
FORGE_BASE="${FORGE_BASE:-$HOME/forge}"
MARKETPLACE="$FORGE_BASE/marketplace"
PLUGIN_DIR="$MARKETPLACE/plugins/mercury"

mkdir -p "$PLUGIN_DIR/.claude-plugin"
mkdir -p "$MARKETPLACE/.claude-plugin"
```

### 4b: Write marketplace.json

```bash
cat > "$MARKETPLACE/.claude-plugin/marketplace.json" << 'MARKETPLACE_EOF'
{
  "name": "forge-local",
  "owner": {
    "name": "forge"
  },
  "plugins": [
    {
      "name": "mercury",
      "description": "Mercury inter-agent message bus channel for Claude Code — push notifications for multi-agent coordination.",
      "category": "productivity",
      "source": "./plugins/mercury"
    }
  ]
}
MARKETPLACE_EOF
```

### 4c: Write plugin.json

```bash
cat > "$PLUGIN_DIR/.claude-plugin/plugin.json" << 'PLUGIN_EOF'
{
  "name": "mercury",
  "description": "Mercury inter-agent message bus channel for Claude Code — push notifications for multi-agent coordination.",
  "version": "0.0.1",
  "keywords": [
    "mercury",
    "messaging",
    "channel",
    "mcp",
    "agents"
  ]
}
PLUGIN_EOF
```

### 4d: Write .mcp.json

This tells Claude Code how to launch the MCP server. The `${CLAUDE_PLUGIN_ROOT}` variable is expanded by Claude Code at runtime to point at the plugin's install directory.

```bash
cat > "$PLUGIN_DIR/.mcp.json" << 'MCP_EOF'
{
  "mcpServers": {
    "mercury": {
      "command": "bun",
      "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--silent", "start"]
    }
  }
}
MCP_EOF
```

### 4e: Write package.json

```bash
cat > "$PLUGIN_DIR/package.json" << 'PKG_EOF'
{
  "name": "claude-channel-mercury",
  "version": "0.0.1",
  "license": "MIT",
  "type": "module",
  "bin": "./server.ts",
  "scripts": {
    "start": "bun install --no-summary && bun server.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
PKG_EOF
```

### 4f: Write tsconfig.json

```bash
cat > "$PLUGIN_DIR/tsconfig.json" << 'TS_EOF'
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["bun-types"]
  },
  "include": ["*.ts"]
}
TS_EOF
```

### 4g: Write server.ts

This is the critical file -- the MCP server that bridges Mercury into Claude Code. It polls the Mercury SQLite DB for new messages and pushes them to Claude Code via `notifications/claude/channel`.

```bash
cat > "$PLUGIN_DIR/server.ts" << 'SERVER_EOF'
#!/usr/bin/env bun
/**
 * Mercury channel for Claude Code.
 *
 * MCP server that bridges the Mercury inter-agent message bus into Claude Code
 * as push notifications. Polls Mercury's SQLite DB for new messages on
 * subscribed channels and delivers them via notifications/claude/channel.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { Database } from 'bun:sqlite'
import { homedir } from 'os'
import { join } from 'path'

// --- Configuration ---

const IDENTITY = process.env.MERCURY_IDENTITY
if (!IDENTITY) {
  process.stderr.write(
    `mercury channel: MERCURY_IDENTITY required\n` +
    `  set env var to your agent identity (e.g. "keeper:murmur", "oracle", "worker:auth")\n`,
  )
  process.exit(1)
}

const POLL_INTERVAL = parseInt(process.env.MERCURY_POLL_INTERVAL ?? '2000', 10)
const DB_PATH = join(homedir(), '.local', 'share', 'mercury', 'mercury.db')

// --- Database ---

function validateSchema(database: Database): void {
  const EXPECTED: Record<string, string[]> = {
    messages: ['id', 'channel', 'sender', 'body', 'created_at'],
    subscriptions: ['agent', 'channel', 'created_at'],
    cursors: ['agent', 'channel', 'last_read_id'],
  }
  for (const [table, requiredCols] of Object.entries(EXPECTED)) {
    const rows = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    const columns = new Set(rows.map(r => r.name))
    const missing = requiredCols.filter(c => !columns.has(c))
    if (missing.length > 0) {
      throw new Error(
        `Mercury schema mismatch: ${table} table is missing columns: ${missing.join(', ')}. ` +
        `See https://github.com/gudnuf/mercury/blob/main/docs/SCHEMA.md`
      )
    }
  }
}

let db: Database

try {
  db = new Database(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  validateSchema(db)
} catch (err) {
  process.stderr.write(`mercury channel: failed to open DB at ${DB_PATH}: ${err}\n`)
  process.exit(1)
}

// --- Prepared Statements ---

const stmtInsertMessage = db.prepare(
  `INSERT INTO messages (channel, sender, body, created_at) VALUES ($channel, $sender, $body, $created_at)`
)

const stmtInsertSubscription = db.prepare(
  `INSERT OR IGNORE INTO subscriptions (agent, channel, created_at) VALUES ($agent, $channel, $created_at)`
)

const stmtDeleteSubscription = db.prepare(
  `DELETE FROM subscriptions WHERE agent = $agent AND channel = $channel`
)

const stmtGetSubscriptions = db.prepare(
  `SELECT channel FROM subscriptions WHERE agent = $agent`
)

const stmtGetCursor = db.prepare(
  `SELECT last_read_id FROM cursors WHERE agent = $agent AND channel = $channel`
)

const stmtUpsertCursor = db.prepare(
  `INSERT INTO cursors (agent, channel, last_read_id) VALUES ($agent, $channel, $last_read_id)
   ON CONFLICT(agent, channel) DO UPDATE SET last_read_id = excluded.last_read_id`
)

const stmtGetNewMessages = db.prepare(
  `SELECT id, channel, sender, body, created_at FROM messages
   WHERE channel = $channel AND id > $last_read_id
   ORDER BY id ASC`
)

const stmtGetLatestId = db.prepare(
  `SELECT COALESCE(MAX(id), 0) as max_id FROM messages WHERE channel = $channel`
)

const stmtChannelStats = db.prepare(
  `SELECT channel, COUNT(*) as count, MAX(created_at) as latest FROM messages GROUP BY channel ORDER BY latest DESC`
)

const stmtGetHistory = db.prepare(
  `SELECT id, channel, sender, body, created_at FROM messages
   WHERE channel = $channel
   ORDER BY id DESC LIMIT $limit`
)

const stmtGetAllHistory = db.prepare(
  `SELECT id, channel, sender, body, created_at FROM messages
   ORDER BY id DESC LIMIT $limit`
)

// --- Types ---

type MessageRow = {
  id: number
  channel: string
  sender: string
  body: string
  created_at: string
}

type ChannelRow = { channel: string }
type CursorRow = { last_read_id: number }
type LatestRow = { max_id: number }
type StatsRow = { channel: string; count: number; latest: string }

// --- Auto-subscribe based on role ---

function autoSubscribe(): void {
  const now = new Date().toISOString()

  // All roles subscribe to status
  stmtInsertSubscription.run({ $agent: IDENTITY, $channel: 'status', $created_at: now })

  const parts = IDENTITY!.split(':')
  const role = parts[0]

  if (role === 'oracle') {
    stmtInsertSubscription.run({ $agent: IDENTITY, $channel: 'studio', $created_at: now })
  } else if (role === 'keeper') {
    stmtInsertSubscription.run({ $agent: IDENTITY, $channel: 'studio', $created_at: now })
    // Subscribe to own channel (e.g. keeper:murmur -> channel "keeper:murmur")
    stmtInsertSubscription.run({ $agent: IDENTITY, $channel: IDENTITY!, $created_at: now })
  } else if (role === 'worker') {
    stmtInsertSubscription.run({ $agent: IDENTITY, $channel: 'workers', $created_at: now })
  }
}

autoSubscribe()

// --- Send startup message ---

function sendStartupMessage(): void {
  const now = new Date().toISOString()
  stmtInsertMessage.run({ $channel: 'status', $sender: IDENTITY, $body: `${IDENTITY} online`, $created_at: now })
}

sendStartupMessage()

// --- MCP Server ---

const mcp = new Server(
  { name: 'mercury', version: '0.0.1' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      `Messages from Mercury arrive as <channel source="plugin:mercury:mercury" chat_id="CHANNEL" user="SENDER" ...>.`,
      `Use the send tool to reply. Pass chat_id as the channel name.`,
      `Mercury is the inter-agent message bus — other Claude sessions communicate through it.`,
      `Your Mercury identity is ${IDENTITY}. Post status updates to the "status" channel.`,
    ].join('\n'),
  },
)

// --- Tools ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send',
      description: 'Send a message to a Mercury channel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string', description: 'Channel name to send to' },
          text: { type: 'string', description: 'Message body' },
        },
        required: ['channel', 'text'],
      },
    },
    {
      name: 'read',
      description: 'Read unread messages from subscribed channels. Updates cursor after reading.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string', description: 'Channel to read (omit for all subscribed channels)' },
        },
      },
    },
    {
      name: 'subscribe',
      description: 'Subscribe to a Mercury channel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string', description: 'Channel name to subscribe to' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'unsubscribe',
      description: 'Unsubscribe from a Mercury channel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string', description: 'Channel name to unsubscribe from' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'channels',
      description: 'List all Mercury channels with message counts.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'log',
      description: 'Show message history for a channel (or all channels).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string', description: 'Channel to show history for (omit for all)' },
          limit: { type: 'number', description: 'Max messages to return (default 20)' },
        },
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'send': {
        const channel = args.channel as string
        const text = args.text as string
        if (!channel || !text) throw new Error('channel and text are required')
        const now = new Date().toISOString()
        const result = stmtInsertMessage.run({ $channel: channel, $sender: IDENTITY, $body: text, $created_at: now })
        return {
          content: [{ type: 'text', text: `sent to #${channel} (id: ${result.lastInsertRowid})` }],
        }
      }

      case 'read': {
        const channel = args.channel as string | undefined
        const channels = channel
          ? [channel]
          : (stmtGetSubscriptions.all({ $agent: IDENTITY }) as ChannelRow[]).map(r => r.channel)

        const lines: string[] = []
        for (const ch of channels) {
          const cursor = stmtGetCursor.get({ $agent: IDENTITY, $channel: ch }) as CursorRow | undefined
          const lastReadId = cursor?.last_read_id ?? 0

          // If no cursor exists, initialize to latest (don't replay history)
          if (!cursor) {
            const latest = stmtGetLatestId.get({ $channel: ch }) as LatestRow
            stmtUpsertCursor.run({ $agent: IDENTITY, $channel: ch, $last_read_id: latest.max_id })
            lines.push(`#${ch}: (cursor initialized, no unread)`)
            continue
          }

          const msgs = stmtGetNewMessages.all({ $channel: ch, $last_read_id: lastReadId }) as MessageRow[]

          if (msgs.length === 0) {
            lines.push(`#${ch}: (no unread)`)
            continue
          }

          let maxId = lastReadId
          for (const m of msgs) {
            lines.push(`#${m.channel} [${m.created_at}] ${m.sender}: ${m.body}`)
            if (m.id > maxId) maxId = m.id
          }
          stmtUpsertCursor.run({ $agent: IDENTITY, $channel: ch, $last_read_id: maxId })
        }

        return {
          content: [{ type: 'text', text: lines.length > 0 ? lines.join('\n') : '(no unread messages)' }],
        }
      }

      case 'subscribe': {
        const channel = args.channel as string
        if (!channel) throw new Error('channel is required')
        const now = new Date().toISOString()
        stmtInsertSubscription.run({ $agent: IDENTITY, $channel: channel, $created_at: now })
        return { content: [{ type: 'text', text: `subscribed to #${channel}` }] }
      }

      case 'unsubscribe': {
        const channel = args.channel as string
        if (!channel) throw new Error('channel is required')
        stmtDeleteSubscription.run({ $agent: IDENTITY, $channel: channel })
        return { content: [{ type: 'text', text: `unsubscribed from #${channel}` }] }
      }

      case 'channels': {
        const rows = stmtChannelStats.all() as StatsRow[]
        if (rows.length === 0) {
          return { content: [{ type: 'text', text: '(no channels)' }] }
        }
        const subs = new Set(
          (stmtGetSubscriptions.all({ $agent: IDENTITY }) as ChannelRow[]).map(r => r.channel)
        )
        const lines = rows.map(r => {
          const marker = subs.has(r.channel) ? '*' : ' '
          return `${marker} #${r.channel}  ${r.count} msgs  (latest: ${r.latest})`
        })
        lines.unshift('(* = subscribed)')
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      case 'log': {
        const channel = args.channel as string | undefined
        const limit = (args.limit as number) ?? 20

        const rows = channel
          ? stmtGetHistory.all({ $channel: channel, $limit: limit }) as MessageRow[]
          : stmtGetAllHistory.all({ $limit: limit }) as MessageRow[]

        if (rows.length === 0) {
          return { content: [{ type: 'text', text: '(no messages)' }] }
        }

        // Reverse to show oldest first
        const lines = rows.reverse().map(m =>
          `[${m.created_at}] #${m.channel} ${m.sender}: ${m.body}`
        )
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }],
      isError: true,
    }
  }
})

// --- Polling for new messages ---

// Track cursors for polling (separate from the tool's cursor — polling uses
// its own in-memory state so tool reads and push notifications don't interfere)
const pollCursors = new Map<string, number>()

function initPollCursors(): void {
  const subs = stmtGetSubscriptions.all({ $agent: IDENTITY }) as ChannelRow[]
  for (const { channel } of subs) {
    // Check if a cursor exists in DB
    const cursor = stmtGetCursor.get({ $agent: IDENTITY, $channel: channel }) as CursorRow | undefined
    if (cursor) {
      pollCursors.set(channel, cursor.last_read_id)
    } else {
      // No cursor — start from latest message (don't replay history)
      const latest = stmtGetLatestId.get({ $channel: channel }) as LatestRow
      pollCursors.set(channel, latest.max_id)
      // Also persist the cursor
      stmtUpsertCursor.run({ $agent: IDENTITY, $channel: channel, $last_read_id: latest.max_id })
    }
  }
}

initPollCursors()

function pollForMessages(): void {
  try {
    // Refresh subscription list (in case tools added new subscriptions)
    const subs = stmtGetSubscriptions.all({ $agent: IDENTITY }) as ChannelRow[]

    for (const { channel } of subs) {
      const lastId = pollCursors.get(channel) ?? 0

      // If this is a new subscription we haven't seen, init from latest
      if (!pollCursors.has(channel)) {
        const latest = stmtGetLatestId.get({ $channel: channel }) as LatestRow
        pollCursors.set(channel, latest.max_id)
        stmtUpsertCursor.run({ $agent: IDENTITY, $channel: channel, $last_read_id: latest.max_id })
        continue
      }

      const msgs = stmtGetNewMessages.all({ $channel: channel, $last_read_id: lastId }) as MessageRow[]

      let maxId = lastId
      for (const m of msgs) {
        // Skip own messages
        if (m.sender === IDENTITY) {
          if (m.id > maxId) maxId = m.id
          continue
        }

        // Push notification to Claude
        mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: m.body,
            meta: {
              chat_id: m.channel,
              message_id: String(m.id),
              user: m.sender,
              ts: m.created_at,
              source: 'mercury',
            },
          },
        }).catch(err => {
          process.stderr.write(`mercury channel: failed to deliver notification: ${err}\n`)
        })

        if (m.id > maxId) maxId = m.id
      }

      if (maxId > lastId) {
        pollCursors.set(channel, maxId)
        stmtUpsertCursor.run({ $agent: IDENTITY, $channel: channel, $last_read_id: maxId })
      }
    }
  } catch (err) {
    process.stderr.write(`mercury channel: poll error: ${err}\n`)
  }
}

const pollTimer = setInterval(pollForMessages, POLL_INTERVAL)

// --- Lifecycle ---

process.on('unhandledRejection', err => {
  process.stderr.write(`mercury channel: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`mercury channel: uncaught exception: ${err}\n`)
})

await mcp.connect(new StdioServerTransport())

process.stderr.write(`mercury channel: online as ${IDENTITY} (polling every ${POLL_INTERVAL}ms)\n`)

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('mercury channel: shutting down\n')
  clearInterval(pollTimer)
  try { db.close() } catch {}
  setTimeout(() => process.exit(0), 1000)
}

process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
SERVER_EOF
```

### 4h: Install npm dependencies

```bash
cd "$PLUGIN_DIR"
bun install
```

---

## Step 5: Register the Marketplace and Install the Plugin

These steps happen inside a Claude Code interactive session.

### 5a: Register the local marketplace

Open Claude Code:

```bash
claude
```

Inside the session, run:

```
/plugin add-marketplace
```

When prompted, choose "local directory" and enter the marketplace path:

```
$HOME/forge/marketplace
```

(Replace `$HOME` with the actual absolute path, e.g., `/home/youruser/forge/marketplace`)

### 5b: Install the Mercury plugin

Still inside Claude Code:

```
/plugin install mercury@forge-local
```

This copies the plugin files to `~/.claude/plugins/mercury/` and registers it in `~/.claude/plugins/installed_plugins.json`.

Exit the session after installing.

---

## Step 6: Configure Mercury for Claude Code Sessions

### The MERCURY_IDENTITY environment variable

The MCP server reads `MERCURY_IDENTITY` to know who the agent is. This must be set before Claude Code launches.

```bash
export MERCURY_IDENTITY="keeper:yourname"
```

### The --dangerously-load-development-channels flag

Mercury push notifications require registering the MCP server as a "development channel." This is done via a Claude Code CLI flag.

**Critical rule:** pass `server:mercury` via `--dangerously-load-development-channels` ONLY. Do NOT also put it in `--channels`. Putting it in both causes `--channels` to check the allowlist and block notifications, overriding the dev channel registration.

### Launch command

```bash
export MERCURY_IDENTITY="keeper:yourname"

claude \
  --dangerously-skip-permissions \
  --dangerously-load-development-channels server:mercury
```

If you also use the Discord plugin:

```bash
export MERCURY_IDENTITY="keeper:yourname"

claude \
  --dangerously-skip-permissions \
  --dangerously-load-development-channels server:mercury \
  --channels plugin:discord@claude-plugins-official
```

### The interactive confirmation dialog

`--dangerously-load-development-channels` triggers an interactive confirmation prompt. In automated setups (tmux), auto-confirm it:

```bash
# In tmux, fire Enter after 3 seconds
if [[ -n "${TMUX_PANE:-}" ]]; then
  (sleep 3 && tmux send-keys -t "$TMUX_PANE" Enter 2>/dev/null) &
fi
```

### Full launch-agent script

For a complete launch script that handles Mercury + Discord + agent state, see the launch-agent reference in the forge personal setup guide, or use the version at:

```
https://github.com/gudnuf/mercury  (referenced from the forge repo)
```

Minimal launch-agent:

```bash
#!/usr/bin/env bash
set -euo pipefail

IDENTITY="${1:?Usage: launch-agent <identity>}"
FORGE_BASE="${FORGE_BASE:-$HOME/forge}"

export MERCURY_IDENTITY="$IDENTITY"

# Subscribe to standard channels
mercury subscribe --as "$IDENTITY" --channel status
mercury subscribe --as "$IDENTITY" --channel "$IDENTITY"

# Announce
mercury send --as "$IDENTITY" --to status "online"

# Auto-confirm dev channels dialog in tmux
if [[ -n "${TMUX_PANE:-}" ]]; then
  (sleep 3 && tmux send-keys -t "$TMUX_PANE" Enter 2>/dev/null) &
fi

exec claude \
  --dangerously-skip-permissions \
  --dangerously-load-development-channels server:mercury
```

---

## Step 7: Verify Everything Works

### 7a: CLI verification

```bash
# Send a test message
mercury send --as "setup-test" --to status "hello from setup"

# Read it back
mercury log --channel status
# Expected: shows your message with timestamp

# Check channels exist
mercury channels
# Expected: lists "status" channel
```

### 7b: MCP plugin verification

Launch Claude Code with Mercury enabled:

```bash
export MERCURY_IDENTITY="test-agent"
claude --dangerously-load-development-channels server:mercury
```

Accept the development channels prompt. Inside the session:

1. Check the MCP server loaded: you should see Mercury tools available (send, read, subscribe, etc.)
2. Use the read tool: `mercury read` -- should show "(no unread messages)" or recent messages
3. Use the send tool: send a message to the status channel
4. From another terminal: `mercury log --channel status` -- your message should appear
5. From another terminal: `mercury send --as "outside" --to status "ping"` -- you should receive a push notification inside the Claude Code session

### 7c: Confirm push notifications work

The key indicator: when you receive a push notification, Claude Code shows it as:

```
<channel source="plugin:mercury:mercury" chat_id="status" user="outside" ...>
ping
</channel>
```

If you see `Listening for channel messages from: server:mercury` in the Claude Code startup output, push notifications are registered.

If you see a warning about `server:mercury` not being in the allowlist, the `--channels` flag is interfering -- remove Mercury from `--channels` and keep it ONLY in `--dangerously-load-development-channels`.

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `mercury: command not found` | Not on PATH | Add the binary's directory to PATH |
| `failed to open DB` | Mercury DB doesn't exist yet | Run any mercury command first (e.g., `mercury channels`) to create it |
| `MERCURY_IDENTITY required` | Env var not set | `export MERCURY_IDENTITY="your:identity"` before launching |
| Plugin not found in Claude Code | Marketplace not registered | Run `/plugin add-marketplace` inside Claude Code |
| Push notifications don't arrive | Mercury in `--channels` too | Remove from `--channels`, keep ONLY in `--dangerously-load-development-channels` |
| `bun: command not found` | Bun not installed | `curl -fsSL https://bun.sh/install \| bash` |
| Schema mismatch error | Old Mercury DB version | Delete `~/.local/share/mercury/mercury.db` and rebuild with latest mercury CLI |

---

## Architecture Notes

**How it fits together:**

```
Mercury CLI (Go)          MCP Plugin (Bun/TS)           Claude Code
     |                         |                            |
     |  mercury send           |  polls DB every 2s         |
     |       |                 |       |                    |
     v       v                 v       v                    v
+--------------------------------------------------------------------+
|              ~/.local/share/mercury/mercury.db                      |
|  messages | subscriptions | cursors                                 |
+--------------------------------------------------------------------+
                               |
                               | notifications/claude/channel
                               +------------------------------> Claude sees
                                                                push messages
```

- The Mercury CLI is the source of truth -- it creates the DB schema on first run.
- The MCP plugin is a consumer -- it reads/writes the same SQLite file via `bun:sqlite`.
- WAL mode enables concurrent access from CLI, MCP plugin, and any other consumers.
- The DB file at `~/.local/share/mercury/mercury.db` is the entire system state.

**Files created by this setup:**

```
$FORGE_BASE/marketplace/
  .claude-plugin/marketplace.json       # marketplace definition
  plugins/mercury/
    .claude-plugin/plugin.json          # plugin metadata
    .mcp.json                           # MCP server launch config
    package.json                        # npm dependencies
    tsconfig.json                       # TypeScript config
    server.ts                           # the MCP server (main file)
    node_modules/                       # installed by bun
    bun.lock                            # lockfile

~/.claude/plugins/mercury/              # installed copy (managed by Claude Code)
~/.claude/plugins/installed_plugins.json # plugin registry
~/.claude/plugins/known_marketplaces.json # marketplace registry
~/.local/share/mercury/mercury.db       # Mercury database (created by CLI)
```
