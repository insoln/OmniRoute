/**
 * #12859 end-to-end through the real chat route: an Anthropic OAuth
 * `403 "Request not allowed"` must not ban the `claude` connection on the
 * first response — it excludes the connection for a short, growing cooldown
 * and only a streak of refusals inside one window escalates to `banned`.
 * Any other claude 403 keeps the previous behaviour (banned on the first one).
 *
 * Pattern mirrors tests/unit/probe-gate-autodisable.test.ts: temp DATA_DIR,
 * real SQLite, `globalThis.fetch` mocked as the upstream.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rr-escalation-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { createProviderConnection, setConnectionRateLimitUntil } =
  await import("../../src/lib/db/providers.ts");
const { buildInternalChatRequest } = await import("../../src/lib/api/modelTestRunner.ts");
const chatRouteModule = await import("../../src/app/api/v1/chat/completions/route.ts");
const postChatCompletion = chatRouteModule.POST;
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const { invalidateDbCache } = await import("../../src/lib/db/readCache.ts");
const { __resetRequestRejectedStreaksForTests, REQUEST_REJECTED_COOLDOWNS_MS } =
  await import("../../open-sse/services/requestRejectedStreak.ts");

const originalFetch = globalThis.fetch;
const MODEL = "claude/claude-sonnet-5";

test.beforeEach(() => {
  resetAllCircuitBreakers();
  __resetRequestRejectedStreaksForTests();
  invalidateDbCache("connections");
});

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function readRow(connId: string) {
  const db = core.getDbInstance() as unknown as {
    prepare: (sql: string) => { get: (id: string) => Record<string, unknown> | undefined };
  };
  return db
    .prepare(
      "SELECT is_active, test_status, rate_limited_until, last_error, last_error_type, error_code FROM provider_connections WHERE id = ?"
    )
    .get(connId);
}

async function createClaudeConnection(): Promise<string> {
  const conn = await createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "rr-escalation",
    accessToken: "claude-oauth-access", // pragma: allowlist secret
    refreshToken: "claude-oauth-refresh", // pragma: allowlist secret
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    isActive: true,
    testStatus: "active",
  });
  return String((conn as { id: string }).id);
}

function mockAnthropic403(message: string): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ type: "error", error: { type: "permission_error", message } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

async function sendOnce(connId: string): Promise<Response> {
  return postChatCompletion(
    buildInternalChatRequest(
      { model: MODEL, messages: [{ role: "user", content: "hi" }], stream: false },
      new AbortController().signal,
      connId
    )
  );
}

function cooldownMsOf(row: Record<string, unknown> | undefined): number {
  const until = row?.rate_limited_until;
  assert.ok(until !== null && until !== undefined, "a cooldown must be persisted");
  // The column holds either an ISO string or an epoch-ms number (stringified).
  const raw = String(until);
  const untilMs = Number.isFinite(Number(raw)) ? Number(raw) : Date.parse(raw);
  assert.ok(Number.isFinite(untilMs), `unparseable rate_limited_until: ${raw}`);
  return untilMs - Date.now();
}

function assertCooldownAbout(row: Record<string, unknown> | undefined, expectedMs: number) {
  const ms = cooldownMsOf(row);
  // Allow the test's own wall-clock drift (a few seconds) either way.
  assert.ok(
    Math.abs(ms - expectedMs) < 30_000,
    `cooldown ≈ ${expectedMs / 60000}min expected, got ${Math.round(ms / 1000)}s`
  );
}

/** Simulate the cooldown elapsing so the next request selects the connection again. */
function elapseCooldown(connId: string) {
  setConnectionRateLimitUntil(connId, null);
  invalidateDbCache("connections");
}

test("claude 403 'Request not allowed': cooldown 5 → 15 min, banned only on the 3rd refusal in a window", async () => {
  const connId = await createClaudeConnection();
  mockAnthropic403("Request not allowed");

  const first = await sendOnce(connId);
  assert.notEqual(first.status, 200);
  let row = readRow(connId);
  assert.equal(row?.is_active, 1, "1st refusal: connection stays active");
  assert.notEqual(row?.test_status, "banned", "1st refusal: not banned");
  assert.equal(row?.last_error_type, "request_rejected");
  assert.equal(Number(row?.error_code), 403);
  assertCooldownAbout(row, REQUEST_REJECTED_COOLDOWNS_MS[0]);

  elapseCooldown(connId);
  await sendOnce(connId);
  row = readRow(connId);
  assert.equal(row?.is_active, 1, "2nd refusal: still active");
  assert.notEqual(row?.test_status, "banned", "2nd refusal: still not banned");
  assertCooldownAbout(row, REQUEST_REJECTED_COOLDOWNS_MS[1]);

  elapseCooldown(connId);
  await sendOnce(connId);
  row = readRow(connId);
  assert.equal(row?.test_status, "banned", "3rd refusal inside the window: terminal");
  assert.equal(row?.is_active, 0);
  assert.match(String(row?.last_error), /3 refusals within 60min/);
});

test("any other claude 403 still bans on the first response (regression guard)", async () => {
  const connId = await createClaudeConnection();
  mockAnthropic403("Your organization has been disabled.");
  await sendOnce(connId);
  const row = readRow(connId);
  assert.equal(row?.test_status, "banned");
  assert.equal(row?.is_active, 0);
});
