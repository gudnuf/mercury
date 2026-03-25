# Mercury GitHub Feed

A lightweight webhook receiver that bridges GitHub events into Mercury channels. GitHub pushes events here; they appear in Mercury and (via routes) in Discord.

## How it works

```
GitHub Org Webhook
        |
        |  POST /webhooks/github
        v
+---------------------+
|  mercury-github-feed |       mercury send
|  (bun/TypeScript)    |--------------------->  Mercury Channels
|                      |    github:<repo>
+---------------------+
```

The service receives GitHub webhook payloads, verifies the HMAC-SHA256 signature, formats a concise message, and writes it to the appropriate Mercury channel using `mercury send`. Stateless — no database, no cursor.

## Requirements

- [Bun](https://bun.sh) runtime
- `mercury` CLI on PATH
- A GitHub webhook secret (shared between GitHub and this service)

## Setup

```bash
cd tools/github-feed
bun install
```

## Configuration

All configuration via environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_WEBHOOK_SECRET` | yes | -- | HMAC secret shared with GitHub |
| `GITHUB_FEED_PORT` | no | `8091` | Port to listen on |
| `MERCURY_BIN` | no | `mercury` | Path to mercury binary |

## Running

```bash
export GITHUB_WEBHOOK_SECRET="your-webhook-secret"
bun run start
```

## GitHub Webhook Configuration

Set up an org-level webhook at `github.com/organizations/<org>/settings/hooks`:

| Setting | Value |
|---------|-------|
| Payload URL | `https://your-domain/webhooks/github` |
| Content type | `application/json` |
| Secret | Same value as `GITHUB_WEBHOOK_SECRET` |
| Events | Pull requests, Check suites, Check runs |
| Active | Yes |

## Channel Routing

Events are routed to Mercury channels based on the repository name:

| Repository | Mercury Channel |
|------------|----------------|
| `damsac-studio` | `keeper:studio` |
| `mercury` | `mercury` |
| (any other) | `keeper:<repo-name>` |

CI events (check_suite, check_run) are also broadcast to the `status` channel.

## Event Formats

```
PR #3 opened on sapling: "iOS build infrastructure" by gudnuf
  https://github.com/damsac/sapling/pull/3

PR #3 merged to main on sapling: "iOS build infrastructure" by gudnuf
  https://github.com/damsac/sapling/pull/3

CI passed for PR #3 (sapling) [GitHub Actions]

CI failed on PR #3 (sapling) -- build-ios step
  https://github.com/damsac/sapling/runs/123456
```

## Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/webhook` | POST | Webhook receiver (primary) |
| `/webhooks/github` | POST | Webhook receiver (alias for Caddy routing) |
| `/` | POST | Webhook receiver (alias) |
| `/health` | GET | Health check (returns "ok") |

## Systemd Service Example

```ini
[Unit]
Description=Mercury GitHub webhook feed
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/path/to/bun run /path/to/tools/github-feed/index.ts
Restart=always
RestartSec=5
Environment=GITHUB_WEBHOOK_SECRET=your-secret
Environment=GITHUB_FEED_PORT=8091

[Install]
WantedBy=multi-user.target
```

## Testing

Send a fake webhook payload locally:

```bash
# Start the service
GITHUB_WEBHOOK_SECRET=test-secret bun run start &

# Compute HMAC and send a test PR event
BODY='{"action":"opened","number":1,"pull_request":{"title":"Test PR","html_url":"https://github.com/test/repo/pull/1","merged":false,"user":{"login":"testuser"},"base":{"ref":"main"}},"repository":{"name":"test-repo","full_name":"test/test-repo"}}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "test-secret" | awk '{print "sha256="$2}')
curl -X POST http://localhost:8091/webhook \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-Hub-Signature-256: $SIG" \
  -d "$BODY"
```
