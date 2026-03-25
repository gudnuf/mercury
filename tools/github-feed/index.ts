import { createHmac, timingSafeEqual } from "crypto";

// -- Configuration ------------------------------------------------------------

interface Config {
  webhookSecret: string;
  port: number;
  mercuryBin: string;
}

function loadConfig(): Config {
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error(
      "GITHUB_WEBHOOK_SECRET is required. Set it to the GitHub webhook HMAC secret."
    );
  }

  return {
    webhookSecret,
    port: parseInt(process.env.GITHUB_FEED_PORT || "8091", 10),
    mercuryBin: process.env.MERCURY_BIN || "mercury",
  };
}

// -- HMAC Verification --------------------------------------------------------

function verifySignature(
  secret: string,
  payload: string,
  signatureHeader: string | null
): boolean {
  if (!signatureHeader) return false;

  const expected = "sha256=" +
    createHmac("sha256", secret).update(payload).digest("hex");

  // Constant-time comparison
  if (expected.length !== signatureHeader.length) return false;
  return timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signatureHeader)
  );
}

// -- Repo to Channel Routing --------------------------------------------------

const REPO_CHANNEL_MAP: Record<string, string> = {
  "damsac-studio": "keeper:studio",
  "mercury": "mercury",
};

function channelForRepo(repoName: string): string {
  return REPO_CHANNEL_MAP[repoName] || `keeper:${repoName}`;
}

// -- Mercury Send -------------------------------------------------------------

async function mercurySend(
  bin: string,
  channel: string,
  message: string
): Promise<void> {
  const proc = Bun.spawn([bin, "send", "--as", "github", "--to", channel, message], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(`[github-feed] mercury send failed (exit ${exitCode}): ${stderr.trim()}`);
  }
}

// -- Event Formatting ---------------------------------------------------------

interface PullRequestEvent {
  action: string;
  number: number;
  pull_request: {
    title: string;
    html_url: string;
    merged: boolean;
    user: { login: string };
    base: { ref: string };
  };
  repository: { name: string; full_name: string };
}

interface CheckSuiteEvent {
  action: string;
  check_suite: {
    conclusion: string | null;
    head_branch: string;
    pull_requests: Array<{ number: number; head: { ref: string } }>;
    app: { name: string };
  };
  repository: { name: string; full_name: string };
}

interface CheckRunEvent {
  action: string;
  check_run: {
    name: string;
    conclusion: string | null;
    html_url: string;
    check_suite: {
      pull_requests: Array<{ number: number }>;
    };
  };
  repository: { name: string; full_name: string };
}

function formatPullRequest(payload: PullRequestEvent): string | null {
  const { action, number, pull_request: pr, repository: repo } = payload;
  const title = pr.title;
  const author = pr.user.login;
  const url = pr.html_url;

  switch (action) {
    case "opened":
      return `\u{1F500} PR #${number} opened on ${repo.name}: "${title}" by ${author}\n  ${url}`;
    case "closed":
      if (pr.merged) {
        return `\u{1F7E3} PR #${number} merged to ${pr.base.ref} on ${repo.name}: "${title}" by ${author}\n  ${url}`;
      }
      return `\u{26D4} PR #${number} closed without merge on ${repo.name}: "${title}"\n  ${url}`;
    case "review_requested":
      return `\u{1F440} Review requested on PR #${number} (${repo.name}): "${title}"\n  ${url}`;
    default:
      return null;
  }
}

function formatCheckSuite(payload: CheckSuiteEvent): string | null {
  const { action, check_suite: cs, repository: repo } = payload;

  if (action !== "completed") return null;

  const conclusion = cs.conclusion;
  const branch = cs.head_branch;
  const prInfo = cs.pull_requests.length > 0
    ? ` for PR #${cs.pull_requests[0].number}`
    : ` on ${branch}`;

  switch (conclusion) {
    case "success":
      return `\u{2705} CI passed${prInfo} (${repo.name}) [${cs.app.name}]`;
    case "failure":
      return `\u{274C} CI failed${prInfo} (${repo.name}) [${cs.app.name}]`;
    case "cancelled":
      return `\u{23F9}\u{FE0F} CI cancelled${prInfo} (${repo.name}) [${cs.app.name}]`;
    default:
      return null;
  }
}

function formatCheckRun(payload: CheckRunEvent): string | null {
  const { action, check_run: cr, repository: repo } = payload;

  if (action !== "completed") return null;

  const conclusion = cr.conclusion;
  const name = cr.name;
  const prInfo = cr.check_suite.pull_requests.length > 0
    ? ` on PR #${cr.check_suite.pull_requests[0].number}`
    : "";

  switch (conclusion) {
    case "failure":
      return `\u{274C} CI failed${prInfo} (${repo.name}) \u{2014} ${name} step\n  ${cr.html_url}`;
    case "cancelled":
      return `\u{23F9}\u{FE0F} CI cancelled${prInfo} (${repo.name}) \u{2014} ${name} step`;
    default:
      // Only report failures for individual check runs; check_suite handles success
      return null;
  }
}

// -- Webhook Handler ----------------------------------------------------------

async function handleWebhook(
  config: Config,
  req: Request
): Promise<Response> {
  // Only accept POST
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Read body
  const body = await req.text();

  // Verify HMAC signature
  const signature = req.headers.get("x-hub-signature-256");
  if (!verifySignature(config.webhookSecret, body, signature)) {
    console.error("[github-feed] HMAC verification failed");
    return new Response("Forbidden", { status: 403 });
  }

  // Parse event type
  const eventType = req.headers.get("x-github-event");

  // Handle ping (sent when webhook is first configured)
  if (eventType === "ping") {
    console.log("[github-feed] Received ping event");
    return new Response("pong", { status: 200 });
  }

  // Parse payload
  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const repoName: string = payload.repository?.name;
  if (!repoName) {
    console.error("[github-feed] No repository name in payload");
    return new Response("OK", { status: 200 });
  }

  // Format message based on event type
  let message: string | null = null;
  let isCiEvent = false;

  switch (eventType) {
    case "pull_request":
      message = formatPullRequest(payload as PullRequestEvent);
      break;
    case "check_suite":
      message = formatCheckSuite(payload as CheckSuiteEvent);
      isCiEvent = true;
      break;
    case "check_run":
      message = formatCheckRun(payload as CheckRunEvent);
      isCiEvent = true;
      break;
    default:
      console.log(`[github-feed] Ignoring event type: ${eventType}`);
      return new Response("OK", { status: 200 });
  }

  if (!message) {
    console.log(`[github-feed] Ignoring ${eventType} action: ${payload.action}`);
    return new Response("OK", { status: 200 });
  }

  // Send to repo-specific channel
  const channel = channelForRepo(repoName);
  console.log(`[github-feed] ${eventType} -> #${channel}: ${message.split("\n")[0]}`);
  await mercurySend(config.mercuryBin, channel, message);

  // CI events also broadcast to status channel
  if (isCiEvent) {
    await mercurySend(config.mercuryBin, "status", message);
  }

  return new Response("OK", { status: 200 });
}

// -- Main ---------------------------------------------------------------------

async function main() {
  const config = loadConfig();
  console.log(`[github-feed] Starting on port ${config.port}`);
  console.log(`[github-feed] Mercury binary: ${config.mercuryBin}`);

  const server = Bun.serve({
    port: config.port,
    async fetch(req) {
      const url = new URL(req.url);

      // Health check
      if (url.pathname === "/health" && req.method === "GET") {
        return new Response("ok", { status: 200 });
      }

      // Webhook endpoint — accept at both root and /webhooks/github
      // (Caddy can route /webhooks/github here, or GitHub can hit the port directly)
      if (
        url.pathname === "/" ||
        url.pathname === "/webhook" ||
        url.pathname === "/webhooks/github"
      ) {
        return handleWebhook(config, req);
      }

      return new Response("Not found", { status: 404 });
    },
  });

  console.log(`[github-feed] Listening on http://localhost:${server.port}`);

  // Graceful shutdown
  function shutdown(signal: string) {
    console.log(`[github-feed] Received ${signal}, shutting down...`);
    server.stop();
    console.log("[github-feed] Goodbye.");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
  console.error(`[github-feed] Fatal: ${e.message}`);
  process.exit(1);
});
