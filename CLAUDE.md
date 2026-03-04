# Mercury

Inter-agent communication bus. Thin text transport over SQLite.

## Key paths

- `cmd/mercury/` — CLI entry point
- `internal/db/` — SQLite operations
- `internal/cmd/` — CLI command implementations
- `PROCESS.md` — the constitution (roles, principles, design)
- `STATE.md` — current phase and next actions

## Development

```
nix develop          # enter dev shell with Go + tools
go build ./cmd/mercury  # build the binary
go test ./...        # run tests
```

## Conventions

- Messages are opaque text — Mercury never interprets content
- Agent names are self-chosen strings, no validation
- Channels are implicit — created on first send or subscribe
- DB lives at ~/.local/share/mercury/mercury.db
- No co-author footers in commit messages
- Keep it simple — Mercury is a thin pipe, not a framework
