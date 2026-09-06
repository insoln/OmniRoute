/**
 * Per-connection streak of upstream per-request refusals (REQUEST_REJECTED —
 * today Anthropic's OAuth `403 "Request not allowed"`, #12859).
 *
 * A single refusal is a hiccup: the same token serves the next request. A run
 * of them is enforcement, and re-sending every request into it is the wrong
 * thing to do to an OAuth account. So the connection is excluded for a short,
 * growing cooldown after each refusal, and only a streak inside one window is
 * escalated to the terminal `banned` state that used to fire on the first one.
 *
 * State is in-memory on purpose: a restart forgets the streak, which errs on
 * the side of a few more cooldowns before escalation — never on the side of a
 * ban the operator has to undo by hand.
 */

/** Refusals must land inside this window to count as one streak. */
export const REQUEST_REJECTED_WINDOW_MS = 60 * 60 * 1000;
/** Streak length at which the connection is written as `banned`. */
export const REQUEST_REJECTED_ESCALATION_THRESHOLD = 3;
/** Cooldown after the 1st, 2nd, … refusal of a streak (last entry repeats). */
export const REQUEST_REJECTED_COOLDOWNS_MS = [5 * 60 * 1000, 15 * 60 * 1000, 45 * 60 * 1000];
export const REQUEST_REJECTED_MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000;

export interface RequestRejectedVerdict {
  /** 1-based position of this refusal in the current streak. */
  streak: number;
  /** How long to exclude the connection from selection; 0 when escalating. */
  cooldownMs: number;
  /** True when the streak reached the threshold — caller writes the terminal state. */
  escalate: boolean;
  windowMs: number;
  threshold: number;
}

interface StreakState {
  count: number;
  windowStartedAt: number;
}

const streaks = new Map<string, StreakState>();

export function recordRequestRejected(
  connectionId: string,
  now: number = Date.now()
): RequestRejectedVerdict {
  const existing = streaks.get(connectionId);
  const continues = !!existing && now - existing.windowStartedAt < REQUEST_REJECTED_WINDOW_MS;
  const streak = continues ? existing.count + 1 : 1;
  const escalate = streak >= REQUEST_REJECTED_ESCALATION_THRESHOLD;

  if (escalate) {
    // The terminal state takes over; a reconnect starts from a clean slate.
    streaks.delete(connectionId);
  } else {
    streaks.set(connectionId, {
      count: streak,
      windowStartedAt: continues ? existing.windowStartedAt : now,
    });
  }

  const step = Math.min(streak, REQUEST_REJECTED_COOLDOWNS_MS.length) - 1;
  const cooldownMs = escalate
    ? 0
    : Math.min(REQUEST_REJECTED_COOLDOWNS_MS[step], REQUEST_REJECTED_MAX_COOLDOWN_MS);

  return {
    streak,
    cooldownMs,
    escalate,
    windowMs: REQUEST_REJECTED_WINDOW_MS,
    threshold: REQUEST_REJECTED_ESCALATION_THRESHOLD,
  };
}

/** Forget a connection's streak (e.g. after an operator reconnect). */
export function clearRequestRejectedStreak(connectionId: string): void {
  streaks.delete(connectionId);
}

/** Test-only: wipe all streaks. */
export function __resetRequestRejectedStreaksForTests(): void {
  streaks.clear();
}
