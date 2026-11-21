import test from "node:test";
import assert from "node:assert/strict";

import { XaiExecutor } from "../../open-sse/executors/xai.ts";
import { applyStreamUsageOptions } from "../../open-sse/executors/streamUsageOptions.ts";

// insoln/OmniRoute#8: xAI chat-completions streams only carry a usage chunk
// when stream_options.include_usage is set. Without it the Claude-format path
// forwards a heuristic estimate that clients treat as real usage.

const credentials = { apiKey: "test-key" };
const chatBody = () => ({
  model: "grok-4.3",
  messages: [{ role: "user", content: "hi" }],
});

test("applyStreamUsageOptions injects include_usage on streaming requests", () => {
  const out = applyStreamUsageOptions({ stream_options: { foo: 1 } }, true);
  assert.deepEqual(out.stream_options, { foo: 1, include_usage: true });
});

test("applyStreamUsageOptions respects disableStreamOptions", () => {
  const out = applyStreamUsageOptions({ stream_options: { include_usage: true } }, true, true);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "stream_options"), false);
});

test("applyStreamUsageOptions strips stream_options from non-streaming requests", () => {
  const out = applyStreamUsageOptions({ stream_options: { include_usage: true } }, false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "stream_options"), false);
  const untouched = { a: 1 };
  assert.equal(applyStreamUsageOptions(untouched, false), untouched);
});

test("XaiExecutor requests streaming usage on the chat-completions path", () => {
  const out = new XaiExecutor().transformRequest(
    "grok-4.3",
    chatBody(),
    true,
    credentials
  ) as Record<string, unknown>;
  assert.deepEqual(out.stream_options, { include_usage: true });
});

test("XaiExecutor omits stream_options when the connection opts out", () => {
  const out = new XaiExecutor().transformRequest("grok-4.3", chatBody(), true, {
    ...credentials,
    providerSpecificData: { disableStreamOptions: true },
  }) as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(out, "stream_options"), false);
});

test("XaiExecutor does not send stream_options on non-streaming requests", () => {
  const out = new XaiExecutor().transformRequest(
    "grok-4.3",
    { ...chatBody(), stream_options: { include_usage: true } },
    false,
    credentials
  ) as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(out, "stream_options"), false);
});
