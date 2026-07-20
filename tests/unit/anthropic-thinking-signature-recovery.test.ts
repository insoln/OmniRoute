import test from "node:test";
import assert from "node:assert/strict";

const {
  executeWithAnthropicThinkingSignatureRecovery,
  isAnthropicThinkingSignatureError,
  stripHistoricalThinkingForSignatureRecovery,
} = await import("@omniroute/open-sse/handlers/chatCore/passthroughHelpers.ts");

function makeHistory() {
  return {
    model: "claude-opus-4-8",
    system: [{ type: "text", text: "system", cache_control: { type: "ephemeral", ttl: "5m" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "start" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old", signature: "FOREIGN" },
          { type: "text", text: "old answer", cache_control: { type: "ephemeral" } },
        ],
      },
      { role: "user", content: [{ type: "text", text: "run tools" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "active 1", signature: "ACTIVE_1" },
          { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "one" }],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "active 2", signature: "ACTIVE_2" },
          { type: "tool_use", id: "toolu_2", name: "Bash", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "two" }],
      },
    ],
    tools: [
      {
        name: "Read",
        input_schema: { type: "object" },
        cache_control: { type: "ephemeral", ttl: "30m" },
      },
    ],
  };
}

test("Anthropic thinking-signature recovery contract", async (t) => {
  await t.test("matches only the exact Anthropic thinking-signature 400", () => {
    assert.equal(
      isAnthropicThinkingSignatureError({
        provider: "claude",
        status: 400,
        message: "messages.5.content.0: Invalid `signature` in `thinking` block",
      }),
      true
    );
    assert.equal(
      isAnthropicThinkingSignatureError({
        provider: "openrouter",
        status: 400,
        message: "Invalid signature in thinking block",
      }),
      false
    );
    assert.equal(
      isAnthropicThinkingSignatureError({
        provider: "claude",
        status: 400,
        message: "thinking blocks in the latest assistant message cannot be modified",
      }),
      false
    );
    assert.equal(
      isAnthropicThinkingSignatureError({
        provider: "claude",
        status: 429,
        message: "Invalid signature in thinking block",
      }),
      false
    );
  });

  await t.test("normal same-model traffic is byte-identical and never retried", async () => {
    const body = makeHistory();
    const snapshot = JSON.stringify(body);
    const calls: unknown[] = [];

    const out = await executeWithAnthropicThinkingSignatureRecovery({
      provider: "claude",
      body,
      execute: async (requestBody) => {
        calls.push(requestBody);
        return { status: 200, message: "ok" };
      },
      getError: (result) => (result.status >= 400 ? result : null),
    });

    assert.equal(out.retried, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], body, "normal path must pass the original body reference");
    assert.equal(
      JSON.stringify(calls[0]),
      snapshot,
      "normal payload and cache shape must not change"
    );
    assert.equal(JSON.stringify(body), snapshot, "input must not be mutated");
  });

  await t.test(
    "exact signature 400 retries once and preserves the complete active tool-use cycle",
    async () => {
      const body = makeHistory();
      const snapshot = structuredClone(body);
      const calls: Array<ReturnType<typeof makeHistory>> = [];

      const out = await executeWithAnthropicThinkingSignatureRecovery({
        provider: "claude",
        body,
        execute: async (requestBody) => {
          calls.push(requestBody as ReturnType<typeof makeHistory>);
          return calls.length === 1
            ? { status: 400, message: "Invalid signature in thinking block" }
            : { status: 200, message: "ok" };
        },
        getError: (result) => (result.status >= 400 ? result : null),
      });

      assert.equal(out.retried, true);
      assert.equal(calls.length, 2, "recovery is bounded to one retry");
      assert.equal(calls[0], body);
      assert.notEqual(calls[1], body);
      assert.deepEqual(body, snapshot, "recovery must not mutate the caller body");

      assert.deepEqual(
        calls[1].messages[1].content.map((block: { type: string }) => block.type),
        ["text"],
        "completed-turn thinking is omitted"
      );
      assert.deepEqual(
        calls[1].messages[3].content,
        body.messages[3].content,
        "first assistant/tool_result pair in the active cycle stays verbatim"
      );
      assert.deepEqual(
        calls[1].messages[5].content,
        body.messages[5].content,
        "interleaved assistant/tool_result pair stays verbatim"
      );
      assert.deepEqual(calls[1].system, body.system, "system cache markers stay unchanged");
      assert.deepEqual(calls[1].tools, body.tools, "tool cache markers stay unchanged");
    }
  );

  await t.test("a repeated signature failure still performs only one retry", async () => {
    let attempts = 0;
    const out = await executeWithAnthropicThinkingSignatureRecovery({
      provider: "anthropic-compatible-test",
      body: makeHistory(),
      execute: async () => {
        attempts += 1;
        return { status: 400, message: "Invalid signature in thinking block" };
      },
      getError: (result) => result,
    });

    assert.equal(out.retried, true);
    assert.equal(out.result.status, 400);
    assert.equal(attempts, 2);
  });

  await t.test("unsafe recovery with only active-cycle thinking sends no retry", async () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "run" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "required", signature: "ACTIVE" },
            { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
        },
      ],
    };
    let attempts = 0;
    const out = await executeWithAnthropicThinkingSignatureRecovery({
      provider: "claude",
      body,
      execute: async () => {
        attempts += 1;
        return { status: 400, message: "Invalid signature in thinking block" };
      },
      getError: (result) => result,
    });

    assert.equal(out.retried, false);
    assert.equal(attempts, 1);
    assert.equal(stripHistoricalThinkingForSignatureRecovery(body), body);
  });
});
