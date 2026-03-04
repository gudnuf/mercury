# Mercury — Process

## What this is

Mercury is a message bus for inter-agent communication. It moves
text between named endpoints, persisted in SQLite. What the text
means, how agents name themselves, what channels exist — that's
all convention, not code. Mercury is deliberately thin so the
communication patterns can evolve without changing the tool.

Named for the alchemical principle of connection — quicksilver
that flows between all the fires in the athanor.

## Core concepts

**Agent**: Any entity that sends or reads messages. Identified
by a self-chosen name (e.g. `oracle`, `keeper:mercury`,
`worker:3`). Mercury does not validate or enforce naming — it
just stores strings.

**Channel**: A named destination for messages. Created implicitly
on first use. An agent subscribes to channels to receive
messages sent there. Channels are just strings — `workers`,
`all`, `debug`, whatever emerges.

**Message**: Opaque text with metadata (sender, channel,
timestamp). Mercury never interprets message content.

## Architecture

- **Language**: Go (single binary)
- **Storage**: SQLite at `~/.local/share/mercury/mercury.db`
- **Interface**: CLI (`mercury send`, `mercury read`, etc.)
- **Build**: Nix flake for reproducible builds and dev shell

## CLI design

```
mercury send --as NAME --to CHANNEL BODY
mercury read --as NAME [--channel CHANNEL] [--since TIMESTAMP] [--follow]
mercury channels [--as NAME]
mercury subscribe --as NAME --channel CHANNEL
mercury unsubscribe --as NAME --channel CHANNEL
mercury log [--channel CHANNEL] [--limit N]
```

`--as` identifies the sender/reader. No authentication — this is
a single-machine tool for a trusted practice.

`--follow` on read is the key UX: it blocks and prints new
messages as they arrive (poll-based is fine for v1).

## Data model

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE subscriptions (
  agent TEXT NOT NULL,
  channel TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (agent, channel)
);

CREATE INDEX idx_messages_channel ON messages(channel);
CREATE INDEX idx_messages_created ON messages(created_at);
```

That's it. Two tables. Messages are never deleted by Mercury.

## Roles

| Role | Who | Responsibility |
|------|-----|----------------|
| **Alchemist** | Human operator | Direction, decisions, final approval |
| **Keeper** | Meta-agent (this pane) | Strategic context, prompt drafting, state |
| **Workers** | Spawned in lab lanes | Implementation of specific components |

## Development workflow

1. Keeper holds context and drafts prompts for workers
2. Workers implement in lanes, commit to branches
3. Alchemist reviews and merges
4. State file updated at each phase transition

## Principles

- **Thin transport**: Mercury moves text. It doesn't interpret it.
- **Convention over code**: Naming, channel structure, message
  format — all evolve through practice, not schema changes.
- **Single binary**: One `mercury` command, no daemons, no config
  files, no setup beyond `nix build`.
- **Log everything**: Messages persist. The history is the
  debugging tool.

## What Mercury is NOT

- Not an agent lifecycle manager (that's tmux-lanes)
- Not a task tracker (that's state files and the alchemist)
- Not a structured protocol (messages are text, period)
- Not networked (single machine, single SQLite file)
