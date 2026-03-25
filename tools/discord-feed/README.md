# Mercury Discord Feed

A lightweight service that mirrors Mercury messages into Discord channels via the routes table. Supports routing different Mercury channels to different Discord channels.

## How it works

```
Mercury SQLite DB (read-only)
        |
        |  poll every 2s
        v
+---------------------+
|  mercury-discord-feed|       discord.js
|  (bun/TypeScript)   |----->  Discord Channel A  (route: status -> discord:123)
|                     |----->  Discord Channel B  (route: * -> discord:456)
+---------------------+
        |
        |  per-route cursors
        v
   cursor dir (~/.local/share/mercury/feed-cursors/)
```

The service reads the `routes` table from Mercury's DB to determine which Mercury channels map to which Discord channels. Each route has its own cursor, so routes can be added without replaying history.

## Requirements

- [Bun](https://bun.sh) runtime
- A Discord bot token with "Send Messages" and "Embed Links" permissions
- Access to Mercury's SQLite database (with `routes` table)

## Setup

```bash
cd tools/discord-feed
bun install
```

## Routes

Routes are managed via the Mercury CLI:

```bash
# Route all messages to a Discord channel (wildcard)
mercury route add --channel '*' --to 'discord:123456789012345678'

# Route a specific Mercury channel to a specific Discord channel
mercury route add --channel 'status' --to 'discord:987654321098765432'

# Set format per route (embed, compact, or plain)
mercury route add --channel 'workers' --to 'discord:111222333444555666' --config '{"format":"compact"}'

# List routes
mercury route list

# Remove a route
mercury route remove --channel 'status' --to 'discord:987654321098765432'
```

### Route matching

- Exact match: `channel = "status"` matches only messages on the `status` channel
- Wildcard: `channel = "*"` matches ALL messages
- A message can match multiple routes and be posted to multiple Discord channels

### Format options

Set via the `config` JSON on each route:

| Format | Description |
|--------|-------------|
| `embed` (default) | Rich embed with color, title, author, body, timestamp |
| `compact` | Single line: `#channel \| sender: body` |
| `plain` | Plain text: `[channel] sender: body` |

## Configuration

Environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | yes | -- | Discord bot token |
| `DISCORD_FEED_CHANNEL_ID` | no | -- | Fallback channel ID if no routes exist |
| `MERCURY_DB_PATH` | no | `~/.local/share/mercury/mercury.db` | Path to Mercury SQLite database |
| `CURSOR_DIR` | no | `~/.local/share/mercury/feed-cursors/` | Directory for per-route cursor files |
| `CURSOR_FILE_PATH` | no | `~/.local/share/mercury/discord-feed-cursor` | Old cursor file (migrated on first run) |
| `POLL_INTERVAL_MS` | no | `2000` | Poll interval in milliseconds |
| `BATCH_LIMIT` | no | `50` | Max messages per poll cycle |

## Running

```bash
export DISCORD_BOT_TOKEN="your-bot-token"
bun run start
```

## Backward compatibility

If no routes are found in the DB, the service falls back to `DISCORD_FEED_CHANNEL_ID` (posting all messages to one channel, the pre-routes behavior). On first startup with routes, the old single cursor file is migrated to per-route cursors.

## Behavior notes

- Routes are refreshed from DB every ~60 seconds (new routes are picked up automatically)
- On startup, if a route has >100 unprocessed messages, the backlog is skipped
- Consecutive duplicate messages from the same sender are skipped
- Cursor writes are atomic (write-to-temp then rename)
- `discord.js` handles Discord rate limits and reconnection automatically
