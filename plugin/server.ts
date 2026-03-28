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
