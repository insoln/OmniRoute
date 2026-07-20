import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Regression: prior-turn thinking blocks must be stripped before history is sent
 * to an Anthropic first-party model, so a signature produced by one model is not
 * replayed to another.
 *
 * Production incident (2026-07-20): multi-turn requests returned a bare
 * "API error". Trace:
 *   target = claude/claude-opus-4-8 →
 *   Anthropic 400 "messages.5.content.0: Invalid `signature` in `thinking` block"
 *   → request failed → client saw "API error".
 *
 * Root cause: a thinking-block signature is bound by Anthropic to the model that
 * produced it. When accumulated history is forwarded to a different model than
 * produced it (combo fallback, retry against another model, any cross-model
 * routing), that model rejects the signature.
 *
 * Fix: Anthropic allows omitting prior-turn thinking blocks (other models ignore
 * them), so we strip them for any Anthropic first-party target — making the
 * history valid regardless of which model produced it — without editing
 * signatures (which would break same-model replay, issue #2454). The one block
 * that must be preserved is the thinking of an OPEN tool-use turn: a trailing
 * assistant message is an unresolved tool_use produced by the model now being
 * called, and Anthropic requires its thinking.
 */

const { stripPriorTurnThinkingForClaudeUpstream } =
  await import("@omniroute/open-sse/handlers/chatCore/passthroughHelpers.ts");

function historyWithThinking() {
  return [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "let me reason", signature: "SIG_FROM_MODEL_A" },
        { type: "text", text: "Hello!" },
      ],
    },
    { role: "user", content: "continue" },
    {
      role: "assistant",
      content: [
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: "Sure." },
      ],
    },
    { role: "user", content: "now do X" },
  ];
}

test("strips thinking + redacted_thinking blocks from prior assistant turns", () => {
  const out = stripPriorTurnThinkingForClaudeUpstream(historyWithThinking());
  const kinds = out
    .filter((m) => m.role === "assistant")
    .flatMap((m) => (Array.isArray(m.content) ? m.content.map((b) => b.type) : []));
  assert.ok(!kinds.includes("thinking"), "thinking blocks must be removed");
  assert.ok(!kinds.includes("redacted_thinking"), "redacted_thinking blocks must be removed");
  const texts = out
    .filter((m) => m.role === "assistant")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === "text")
    .map((b) => b.text);
  assert.deepEqual(texts, ["Hello!", "Sure."], "text blocks must survive");
});

test("preserves the thinking of an open tool-use turn (trailing assistant message)", () => {
  // Final message is an assistant turn with an unresolved tool_use: its thinking
  // was produced by the model now being called and must be kept verbatim.
  const msgs = [
    { role: "user", content: "start" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "prior reasoning", signature: "OLD" },
        { type: "text", text: "step 1 done" },
      ],
    },
    { role: "user", content: "keep going" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "current reasoning", signature: "CURRENT" },
        { type: "tool_use", id: "tu_1", name: "search", input: {} },
      ],
    },
  ];
  const out = stripPriorTurnThinkingForClaudeUpstream(msgs);
  assert.deepEqual(
    out[1].content.map((b) => b.type),
    ["text"],
    "prior-turn thinking must be stripped"
  );
  assert.deepEqual(
    out[3].content.map((b) => b.type),
    ["thinking", "tool_use"],
    "open tool-use turn thinking must be preserved"
  );
  assert.equal(out[3].content[0].signature, "CURRENT", "signature kept verbatim on open turn");
});

test("an assistant turn left with no content after stripping keeps a valid shape", () => {
  const msgs = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "S" }] },
    { role: "user", content: "next" },
  ];
  const out = stripPriorTurnThinkingForClaudeUpstream(msgs);
  const asst = out.find((m) => m.role === "assistant");
  assert.ok(asst, "assistant turn preserved");
  assert.ok(Array.isArray(asst.content), "content stays an array");
  assert.equal(
    asst.content.length,
    0,
    "thinking-only turn becomes empty content, not a dangling signature"
  );
});

test("leaves string-content and thinking-free histories untouched", () => {
  const msgs = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "plain string reply" },
    { role: "user", content: "again" },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ];
  const out = stripPriorTurnThinkingForClaudeUpstream(msgs);
  assert.deepEqual(out, msgs, "no thinking blocks → no change");
});

test("is a pure function — does not mutate the input array/objects", () => {
  const msgs = historyWithThinking();
  const snapshot = JSON.parse(JSON.stringify(msgs));
  stripPriorTurnThinkingForClaudeUpstream(msgs);
  assert.deepEqual(msgs, snapshot, "input must not be mutated in place");
});
