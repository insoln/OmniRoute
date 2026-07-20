import { FORMATS } from "../../translator/formats.ts";
import { isClaudeCodeCompatibleProvider } from "../../services/claudeCodeCompatible.ts";
import { getHeaderValueCaseInsensitive } from "./headers.ts";

export function shouldUseNativeCodexPassthrough({
  provider,
  sourceFormat,
  endpointPath,
}: {
  provider?: string | null;
  sourceFormat?: string | null;
  endpointPath?: string | null;
}): boolean {
  if (provider !== "codex") return false;
  if (sourceFormat !== FORMATS.OPENAI_RESPONSES) return false;
  let normalizedEndpoint = String(endpointPath || "");
  while (normalizedEndpoint.endsWith("/")) normalizedEndpoint = normalizedEndpoint.slice(0, -1);
  const segments = normalizedEndpoint.split("/");
  return segments.includes("responses");
}

/**
 * Pass `thinking` / `redacted_thinking` blocks through UNCHANGED.
 *
 * This used to rewrite every assistant thinking block to `redacted_thinking`
 * carrying a synthetic signature, on the assumption that a thinking signature is
 * bound to the auth token that produced it and would be rejected after a token /
 * model switch with 400 "Invalid signature in thinking block" (issue #2454).
 *
 * That rewrite is the actual cause of a different, far more common failure on the
 * Anthropic-native Claude OAuth passthrough:
 *
 *   400 messages.N.content.M: `thinking` or `redacted_thinking` blocks in the
 *   latest assistant message cannot be modified. These blocks must remain as
 *   they were in the original response.
 *
 * The Messages API validates submitted thinking blocks against the original
 * response and rejects ANY modification — so converting them to
 * `redacted_thinking` makes every multi-turn request with thinking fail (most
 * visible on long Claude Code tool-loops). The thinking-block signature is
 * validated server-side by Anthropic and stays valid when the blocks are replayed,
 * including under a different OAuth token — verified by preserving the blocks
 * across a mid-conversation account switch with zero "Invalid signature"
 * responses. The redaction is therefore both unnecessary and the cause of the
 * regression, so the blocks are now returned verbatim. The `signature` parameter
 * is kept for call-site compatibility.
 */
export function redactPassthroughThinkingSignatures(
  messages: unknown,
  _signature: string
): unknown {
  return messages;
}

/**
 * Strip `thinking` / `redacted_thinking` blocks from prior assistant turns when
 * the request is being replayed to a DIFFERENT model than produced them.
 *
 * A thinking-block signature is bound by Anthropic to the model that generated
 * it. Combo routing replays one shared message history across several candidate
 * models, so a signature minted by the previous turn's model is rejected by the
 * next candidate with `400 … Invalid signature in thinking block`, which in a
 * combo chain surfaces to the client as a bare "API error" once every candidate
 * has been tried.
 *
 * Anthropic's documented rule for multi-turn extended thinking is: when you
 * switch models, remove `thinking` / `redacted_thinking` blocks from prior
 * assistant turns — they are model-specific and other models ignore them (they
 * only add input tokens). We must NOT rewrite or re-sign the blocks — editing a
 * thinking block is itself rejected and breaks same-model replay (issue #2454) —
 * so we drop the whole block. Callers apply this ONLY on a model switch (combo
 * targets), never on a direct same-model passthrough.
 *
 * Pure: returns a new array; the input is not mutated.
 */
export function stripPriorTurnThinkingForModelSwitch<
  T extends { role?: unknown; content?: unknown },
>(messages: T[]): T[] {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
      return message;
    }
    const filtered = message.content.filter((block) => {
      const type = (block as { type?: unknown } | null)?.type;
      return type !== "thinking" && type !== "redacted_thinking";
    });
    if (filtered.length === message.content.length) return message;
    return { ...message, content: filtered };
  });
}

export function isClaudeCodeSemanticPassthroughRequest({
  provider,
  sourceFormat,
  targetFormat,
  headers,
  userAgent,
}: {
  provider?: string | null;
  sourceFormat?: string | null;
  targetFormat?: string | null;
  headers?: Record<string, unknown> | Headers | null;
  userAgent?: string | null;
}): boolean {
  const isDirectClaudeCodeProvider =
    provider === "claude" || isClaudeCodeCompatibleProvider(provider);
  if (!isDirectClaudeCodeProvider) return false;
  if (sourceFormat !== FORMATS.CLAUDE) return false;
  if (targetFormat !== FORMATS.CLAUDE) return false;

  const headerUserAgent = getHeaderValueCaseInsensitive(headers, "user-agent");
  const ua = `${userAgent || ""} ${headerUserAgent || ""}`.toLowerCase();
  if (ua.includes("claude-code") || ua.includes("claude-cli")) return true;

  const appHeader = getHeaderValueCaseInsensitive(headers, "x-app");
  if (typeof appHeader === "string" && appHeader.trim().toLowerCase() === "cli") return true;

  const sessionId = getHeaderValueCaseInsensitive(headers, "x-claude-code-session-id");
  return typeof sessionId === "string" && sessionId.trim().length > 0;
}
