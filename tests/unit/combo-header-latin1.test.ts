import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Regression: combo diagnostics headers must be Latin-1 (ByteString) safe.
 *
 * Production incident (2026-07-18): when every model in a combo chain failed,
 * `handleComboChat` → `errorResponseWithComboDiagnostics` projected the terminal
 * reason string into the `x-omniroute-combo-terminal-reason` HTTP header. That
 * string carries an em-dash (U+2014, e.g. "... — please reconnect in the
 * dashboard"), and HTTP header values must be Latin-1. `new Response(...)` threw:
 *
 *   TypeError: Cannot convert argument to a ByteString because the character at
 *   index N has a value of 8212 which is greater than 255.
 *
 * The uncaught throw surfaced to the client as a bare HTTP 500 instead of the
 * intended structured combo error. This test reproduces the crash and locks in
 * the fix (non-Latin1 chars stripped from header projections; full text still in
 * the JSON body).
 */

const { errorResponseWithComboDiagnostics } = await import(
  "@omniroute/open-sse/utils/error.ts"
);

const EM_DASH = "—"; // U+2014, 8212 — greater than 255

test("errorResponseWithComboDiagnostics does not throw when diagnostics contain non-Latin1 chars", () => {
  const diagnostics = {
    poolSize: 1,
    attempted: 4,
    excluded: [
      {
        provider: "openrouter",
        model: "~anthropic/claude-fable-latest",
        reason: `credits exhausted ${EM_DASH} please reconnect`,
      },
    ],
    attemptOrder: [],
    terminalReason: `[openrouter] All 1 connection(s) credits exhausted ${EM_DASH} please reconnect in the dashboard`,
  };

  let resp: Response;
  assert.doesNotThrow(() => {
    resp = errorResponseWithComboDiagnostics(503, `all models failed ${EM_DASH} giving up`, diagnostics);
  }, "must not throw a ByteString TypeError when building headers");

  // Header value must be pure Latin-1 (every char code <= 255).
  const terminal = resp!.headers.get("x-omniroute-combo-terminal-reason") ?? "";
  for (const ch of terminal) {
    assert.ok(
      ch.charCodeAt(0) <= 255,
      `terminal-reason header must be Latin-1; found char code ${ch.charCodeAt(0)}`
    );
  }
  assert.ok(!terminal.includes(EM_DASH), "em-dash must be stripped from the header");

  const excluded = resp!.headers.get("x-omniroute-combo-excluded") ?? "";
  for (const ch of excluded) {
    assert.ok(
      ch.charCodeAt(0) <= 255,
      `excluded header must be Latin-1; found char code ${ch.charCodeAt(0)}`
    );
  }
});

test("errorResponseWithComboDiagnostics keeps the readable message (em-dash) in the JSON body", async () => {
  const diagnostics = {
    poolSize: 1,
    attempted: 1,
    excluded: [],
    attemptOrder: [],
    terminalReason: `credits exhausted ${EM_DASH} reconnect`,
  };
  const resp = errorResponseWithComboDiagnostics(
    503,
    `all models failed ${EM_DASH} giving up`,
    diagnostics
  );
  const body = (await resp.json()) as {
    error?: { message?: string };
    diagnostics?: { terminalReason?: string };
  };
  // Body is UTF-8 JSON, so the human-readable em-dash survives here (only the
  // header projection is down-coded to Latin-1).
  assert.ok(
    body.error?.message?.includes(EM_DASH),
    "JSON error.message should preserve the readable em-dash"
  );
});
