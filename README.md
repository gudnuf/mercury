# Mercury

Inter-agent message bus for multi-agent AI systems. Mercury moves text between named agents over a shared SQLite database -- no daemon, no config files, no network.

## Quick start

```bash
# Build from source (requires Nix)
nix build github:gudnuf/mercury
# Or: nix profile install github:gudnuf/mercury

# Send a message
mercury send --as oracle --to status "system online"

# Subscribe and read
mercury subscribe --as worker:auth --channel status
mercury read --as worker:auth
# => [status] oracle: system online

# Follow mode (polls for new messages)
mercury read --as worker:auth --follow
```

## How it works

Mercury is a CLI tool that reads and writes to a single SQLite file at `~/.local/share/mercury/mercury.db`. There is no server process -- every invocation opens the database directly. WAL mode enables concurrent access from multiple agents.

```
Agent A                     Agent B                     Agent C
   |                           |                           |
   |  mercury send             |  mercury send             |  mercury read
   |       |                   |       |                   |       |
   v       v                   v       v                   v       v
+--------------------------------------------------------------------+
|                    mercury.db (SQLite + WAL)                        |
|  messages | subscriptions | cursors                                 |
+--------------------------------------------------------------------+
```

**Key concepts:**

- **Agent** -- any entity that sends or reads messages, identified by a self-chosen name (e.g. `oracle`, `keeper:studio`, `worker:auth`). Mercury does not validate or enforce naming.
- **Channel** -- a named destination for messages, created implicitly on first use (e.g. `status`, `workers`, `studio`).
- **Cursor** -- tracks each agent's read position per channel. After reading, the cursor advances so the same messages aren't returned twice.
- **Polling** -- `mercury read --follow` polls the database at 500ms intervals. There are no push notifications at the CLI level.

## CLI reference

### send

Send a message to a channel.

```bash
mercury send --as <name> --to <channel> <body>

# Body can also come from stdin
echo "deployment complete" | mercury send --as deploy-bot --to status
```

### read

Read unread messages from subscribed channels.

```bash
mercury read --as <name>                    # all subscribed channels
mercury read --as <name> --channel status   # specific channel
mercury read --as <name> --follow           # poll for new messages
mercury read --as <name> --verbose          # include timestamps
```

### subscribe / unsubscribe

Manage channel subscriptions.

```bash
mercury subscribe --as <name> --channel <channel>
mercury unsubscribe --as <name> --channel <channel>
```

### channels

List all channels that have messages.

```bash
mercury channels
```

### log

Show message history (most recent first, reversed to display oldest-first).

```bash
mercury log                          # last 50 messages, all channels
mercury log --channel status         # filter by channel
mercury log --limit 100              # more history
```

## Architecture

### Database schema

Mercury uses 3 core tables: `messages`, `subscriptions`, and `cursors`. A 4th table (`routes`) is being added for transport routing.

See **[docs/SCHEMA.md](docs/SCHEMA.md)** for the complete schema reference, including column definitions, relationships, and guidance for building new consumers.

### Consumers

Mercury's SQLite database is designed to be read by multiple consumers:

| Consumer | Language | Access | Description |
|----------|----------|--------|-------------|
| `mercury` CLI | Go | read/write | Source of truth. Creates the DB and schema on first run. |
| MCP server plugin | TypeScript/Bun | read/write | Bridges Mercury into Claude Code as push notifications. Polls for new messages and delivers them via MCP's `notifications/claude/channel`. Lives in [`plugin/`](plugin/). |
| Discord feed | TypeScript/Bun | read-only | Mirrors Mercury messages to a Discord channel as formatted embeds. Maintains its own cursor in a file. Lives at `tools/discord-feed/`. |

All consumers validate the database schema on startup and fail with a clear error if expected columns are missing.

### Why SQLite

- Zero setup -- no server to run, no ports to configure
- Concurrent access via WAL mode works well for the multi-agent use case
- The database file is the entire system state -- easy to back up, inspect, or reset
- Every agent session and every consumer can open the file directly

## Building

```bash
# Nix (recommended)
nix build              # produces result/bin/mercury
nix develop            # dev shell with Go + gopls + sqlite

# Plain Go
go build ./cmd/mercury
go test ./...
```

## Project layout

```
cmd/mercury/       CLI entry point
internal/db/       SQLite operations (schema, queries)
internal/cmd/      CLI command implementations (cobra)
plugin/            Claude Code MCP plugin (TypeScript/Bun)
tools/             Companion tools
  discord-feed/    Discord mirror service
docs/              Documentation
  SCHEMA.md        Canonical database schema reference
  setup-skill.md   Full setup guide for Mercury + MCP plugin
flake.nix          Nix flake (build + dev shell)
```

## Design principles

- **Thin transport** -- Mercury moves text. It does not interpret message content.
- **Convention over code** -- naming, channel structure, and message format evolve through practice, not schema changes.
- **Single binary** -- one `mercury` command, no daemons, no config files.
- **Log everything** -- messages persist forever. The history is the debugging tool.
- **Trust-based** -- no authentication. This is a single-machine tool for a trusted multi-agent practice.

## Claude Code Integration

The `plugin/` directory contains an MCP server that bridges Mercury into [Claude Code](https://docs.anthropic.com/en/docs/claude-code) as a real-time push channel. When running, Claude Code agents can send and receive Mercury messages without polling -- messages arrive as push notifications.

### What the plugin does

- Polls the Mercury SQLite DB every 2 seconds for new messages on subscribed channels
- Delivers them to Claude Code via MCP's `notifications/claude/channel` protocol
- Exposes Mercury tools (send, read, subscribe, unsubscribe, channels, log) inside Claude Code sessions
- Auto-subscribes agents to standard channels based on their role (e.g. keepers get `status` + `studio` + their own channel)

### Quick install

For a complete step-by-step guide including dependency installation, plugin registration, and verification, see **[docs/setup-skill.md](docs/setup-skill.md)**.

The short version:

1. Install [Bun](https://bun.sh/) (the plugin uses `bun:sqlite` for direct DB access)
2. Install the Mercury CLI (see [Quick start](#quick-start) above)
3. Register this repo as a local Claude Code plugin marketplace (`/plugin add-marketplace` inside Claude Code, point it at this repo's root)
4. Install the plugin: `/plugin install mercury@mercury-local`
5. Launch Claude Code with the development channels flag:

```bash
export MERCURY_IDENTITY="keeper:yourname"

claude \
  --dangerously-skip-permissions \
  --dangerously-load-development-channels server:mercury
```

### Critical: the --dangerously-load-development-channels flag

Mercury push notifications require the MCP server to be registered as a "development channel." This is done via the `--dangerously-load-development-channels` CLI flag.

**The gotcha:** pass `server:mercury` via `--dangerously-load-development-channels` ONLY. Do NOT also put it in `--channels`. If you put it in both, `--channels` checks the allowlist and blocks notifications, silently overriding the development channel registration. Push notifications will not arrive and there will be no error -- just silence.

```bash
# CORRECT -- push notifications work
claude --dangerously-load-development-channels server:mercury

# WRONG -- push notifications silently blocked
claude --dangerously-load-development-channels server:mercury --channels server:mercury

# CORRECT -- Mercury as dev channel, Discord as regular channel
claude \
  --dangerously-load-development-channels server:mercury \
  --channels plugin:discord@claude-plugins-official
```

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MERCURY_IDENTITY` | Yes | -- | Agent identity (e.g. `keeper:studio`, `worker:auth`, `oracle`) |
| `MERCURY_POLL_INTERVAL` | No | `2000` | Poll interval in milliseconds |

### Plugin as a local marketplace

This repo includes a `.claude-plugin/marketplace.json` at the root, so you can register the entire repo as a local Claude Code plugin marketplace. Inside Claude Code:

```
/plugin add-marketplace
# choose "local directory" and enter the path to this repo
/plugin install mercury@mercury-local
```
