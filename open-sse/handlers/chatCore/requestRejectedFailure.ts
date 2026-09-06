import { updateProviderConnection } from "@/lib/db/providers";
import { shouldIsolateProbeFailures } from "@/shared/utils/probeOrigin";
import { writeTerminalStatus } from "@/shared/utils/terminalStatus";

import { PROVIDER_ERROR_TYPES } from "../../services/errorClassifier.ts";
import { recordRequestRejected } from "../../services/requestRejectedStreak.ts";

/**
 * chatCore leaf for PROVIDER_ERROR_TYPES.REQUEST_REJECTED (#12859 — Anthropic
 * OAuth 403 "Request not allowed").
 *
 * The upstream refused THIS request, not the credential: the same token serves
 * the next request. One refusal must not ban the connection — but a run of
 * them is enforcement, and re-sending every request into it would be wrong.
 * So: exclude the connection for a short, growing cooldown and escalate to
 * `banned` only for a streak inside one window (services/requestRejectedStreak).
 *
 * Probe-origin failures (dashboard test-all) are recorded on the connection
 * but never cool it down or ban it (#9817).
 */
export async function handleRequestRejectedFailure(params: {
  connectionId: string;
  statusCode: number;
  message: string;
}): Promise<void> {
  const { connectionId, statusCode, message } = params;
  const verdict = recordRequestRejected(connectionId);
  const probeIsolated = await shouldIsolateProbeFailures();
  const windowMin = Math.round(verdict.windowMs / 60000);

  if (verdict.escalate && !probeIsolated) {
    await writeTerminalStatus(
      connectionId,
      {
        testStatus: "banned",
        isActive: false,
        lastError: `${message} (${verdict.streak} refusals within ${windowMin}min — treated as upstream enforcement)`,
        lastErrorType: PROVIDER_ERROR_TYPES.FORBIDDEN,
        errorCode: String(statusCode),
      },
      "production"
    );
    console.warn(
      `[provider] Node ${connectionId} refused ${verdict.streak}x within ${windowMin}min (${statusCode}) — disabling, reconnect required`
    );
    return;
  }

  await updateProviderConnection(connectionId, {
    lastErrorType: PROVIDER_ERROR_TYPES.REQUEST_REJECTED,
    lastError: message,
    errorCode: statusCode,
  });
  if (!probeIsolated) {
    try {
      const { setConnectionRateLimitUntil } = await import("@/lib/db/providers");
      setConnectionRateLimitUntil(connectionId, Date.now() + verdict.cooldownMs);
    } catch {
      // DB write failure must never break the fallback loop
    }
  }
  console.warn(
    `[provider] Node ${connectionId} request refused by upstream (${statusCode}) — excluded for ${Math.ceil(verdict.cooldownMs / 1000)}s (refusal ${verdict.streak}/${verdict.threshold} in window), trying other accounts`
  );
}
