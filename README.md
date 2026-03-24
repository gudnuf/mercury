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
| MCP server plugin | TypeScript/Bun | read/write | Bridges Mercury into Claude Code as push notifications. Polls for new messages and delivers them via MCP's `notifications/claude/channel`. Lives in [damsac-studio](https://github.com/gudnuf/damsac-studio) at `plugins/mercury/server.ts`. |
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
tools/             Companion tools
  discord-feed/    Discord mirror service
docs/              Documentation
  SCHEMA.md        Canonical database schema reference
flake.nix          Nix flake (build + dev shell)
```

## Design principles

- **Thin transport** -- Mercury moves text. It does not interpret message content.
- **Convention over code** -- naming, channel structure, and message format evolve through practice, not schema changes.
- **Single binary** -- one `mercury` command, no daemons, no config files.
- **Log everything** -- messages persist forever. The history is the debugging tool.
- **Trust-based** -- no authentication. This is a single-machine tool for a trusted multi-agent practice.
