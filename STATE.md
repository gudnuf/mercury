# Mercury — State

## Phase

Genesis complete. Ready for implementation.

## Decisions made

- Named channels, created on-the-fly
- CLI tool in Go, single binary
- SQLite at ~/.local/share/mercury/mercury.db
- Role-based agent names (self-chosen, unenforced)
- Messages are opaque text, persist as log
- Nix flake for builds and dev shell
- Maximally flexible — convention evolves in practice, not in code

## Implementation plan

### Milestone 1: Core (MVP)

1. Scaffold Go project with Nix flake
2. SQLite schema + migration on first run
3. `mercury send --as NAME --to CHANNEL BODY`
4. `mercury read --as NAME` (show unread from subscribed channels)
5. `mercury subscribe --as NAME --channel CHANNEL`
6. `mercury channels` (list known channels)

### Milestone 2: Usability

7. `mercury read --follow` (poll and block for new messages)
8. `mercury log` (full history, optionally filtered)
9. `mercury unsubscribe`
10. Cursor tracking (per-agent read position so "unread" works)

### Milestone 3: Integration

11. Shell helpers for tmux-lanes integration
12. Smoke test: two agents exchange messages without human relay
13. Document conventions that emerged during dogfooding

## Active lanes

None yet.

## Blockers

None.

## Next action

Scaffold Go project with Nix flake, implement send + read + subscribe.
