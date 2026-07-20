import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Regression: combo cross-model fallback must strip prior-turn thinking blocks.
 *
 * Production incident (2026-07-20): `combo/ultra` and `combo/smart` returned a
 * bare "API error" on multi-turn Claude Code sessions. Trace:
 *   combo target 1 = claude/claude-opus-4-8 →
 *   Anthropic 400 "messages.5.content.0: Invalid `signature` in `thinking` block"
 *   → opus failed → next target openrouter/…opus-latest → 401 credits exhausted
 *   → all models failed → client sees "API error".
 *
 * Root cause: combo replays the SAME message history (carrying thinking blocks
 * whose signature was produced by a DIFFERENT model in the prior turn) to each
 * candidate model. Anthropic binds a thinking signature to the model that
 * generated it, so replaying it to another model is rejected.
 *
 * Anthropic's documented rule (extended thinking, multi-turn): when you switch
 * models, STRIP `thinking` / `redacted_thinking` blocks from prior assistant
 * turns — they are model-specific and other models ignore them. We must NOT edit
 * the signature (that breaks same-model replay, issue #2454); we remove the whole
 * block. This only applies on model switch (combo targets), never on a direct
 * same-model passthrough.
 */

const { stripPriorTurnThinkingForModelSwitch } =
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

test("strips thinking + redacted_thinking blocks from prior assistant turns on model switch", () => {
  const out = stripPriorTurnThinkingForModelSwitch(historyWithThinking());
  const kinds = out
    .filter((m) => m.role === "assistant")
    .flatMap((m) => (Array.isArray(m.content) ? m.content.map((b) => b.type) : []));
  assert.ok(!kinds.includes("thinking"), "thinking blocks must be removed");
  assert.ok(!kinds.includes("redacted_thinking"), "redacted_thinking blocks must be removed");
  // Non-thinking content is preserved.
  const texts = out
    .filter((m) => m.role === "assistant")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === "text")
    .map((b) => b.text);
  assert.deepEqual(texts, ["Hello!", "Sure."], "text blocks must survive");
});

test("an assistant turn left with no content after stripping keeps a valid shape", () => {
  const msgs = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "S" }] },
    { role: "user", content: "next" },
  ];
  const out = stripPriorTurnThinkingForModelSwitch(msgs);
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
  const out = stripPriorTurnThinkingForModelSwitch(msgs);
  assert.deepEqual(out, msgs, "no thinking blocks → no change");
});

test("is a pure function — does not mutate the input array/objects", () => {
  const msgs = historyWithThinking();
  const snapshot = JSON.parse(JSON.stringify(msgs));
  stripPriorTurnThinkingForModelSwitch(msgs);
  assert.deepEqual(msgs, snapshot, "input must not be mutated in place");
});
