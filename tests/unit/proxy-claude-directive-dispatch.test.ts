import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-proxy-directive-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { CliproxyapiExecutor } = await import("../../open-sse/executors/cliproxyapi.ts");
const { DarioExecutor } = await import("../../open-sse/executors/dario.ts");
const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

type ProxyExecutor = {
  execute(input: {
    model: string;
    body: unknown;
    stream: boolean;
    credentials: Record<string, unknown>;
  }): Promise<unknown>;
};

type CapturedBody = {
  messages?: Array<Record<string, unknown>>;
};

async function captureWireBody(executor: ProxyExecutor, body: Record<string, unknown>) {
  let capturedBody: CapturedBody | undefined;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { body?: unknown } = {}) => {
    capturedBody = JSON.parse(String(init.body ?? "{}")) as CapturedBody;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  try {
    await executor.execute({
      model: "claude-opus-5",
      body,
      stream: false,
      credentials: {},
    });
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(capturedBody, "fetch did not capture a request body");
  return capturedBody;
}

const executorCases = [
  ["CLIProxyAPI", () => new CliproxyapiExecutor()],
  ["Dario", () => new DarioExecutor()],
] as const;

for (const [name, createExecutor] of executorCases) {
  test(`${name} Anthropic dispatch relocates a leading directive-only message`, async () => {
    const directive = {
      role: "system",
      content: [],
      output_config: { effort: "medium" },
    };
    const captured = await captureWireBody(createExecutor(), {
      model: "claude-opus-5",
      max_tokens: 64,
      system: [{ type: "text", text: "You are Claude." }],
      messages: [directive, { role: "user", content: "hello" }],
      stream: false,
    });

    assert.deepEqual(captured.messages, [{ role: "user", content: "hello" }, directive]);
  });

  test(`${name} OpenAI dispatch leaves an initial system message untouched`, async () => {
    const messages = [
      { role: "system", content: "Be concise" },
      { role: "user", content: "hello" },
    ];
    const captured = await captureWireBody(createExecutor(), {
      model: "claude-opus-5",
      messages,
      stream: false,
    });

    assert.deepEqual(captured.messages, messages);
  });
}
