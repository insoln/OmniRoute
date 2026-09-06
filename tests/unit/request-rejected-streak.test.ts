/**
 * open-sse/services/requestRejectedStreak.ts (#12859): per-connection streak
 * of upstream per-request refusals → growing cooldown, escalation only for a
 * run inside one window.
 */
import test from "node:test";
import assert from "node:assert/strict";

const {
  recordRequestRejected,
  clearRequestRejectedStreak,
  __resetRequestRejectedStreaksForTests,
  REQUEST_REJECTED_WINDOW_MS,
  REQUEST_REJECTED_ESCALATION_THRESHOLD,
  REQUEST_REJECTED_COOLDOWNS_MS,
} = await import("../../open-sse/services/requestRejectedStreak.ts");

const MIN = 60 * 1000;

test.beforeEach(() => __resetRequestRejectedStreaksForTests());

test("first refusal: short cooldown, no escalation", () => {
  const v = recordRequestRejected("conn-a", 1_000_000);
  assert.equal(v.streak, 1);
  assert.equal(v.escalate, false);
  assert.equal(v.cooldownMs, 5 * MIN);
  assert.equal(v.threshold, REQUEST_REJECTED_ESCALATION_THRESHOLD);
  assert.equal(v.windowMs, REQUEST_REJECTED_WINDOW_MS);
});

test("refusals inside the window grow the cooldown and escalate at the threshold", () => {
  const t0 = 1_000_000;
  const first = recordRequestRejected("conn-a", t0);
  const second = recordRequestRejected("conn-a", t0 + 5 * MIN);
  const third = recordRequestRejected("conn-a", t0 + 20 * MIN);
  assert.deepEqual(
    [first.cooldownMs, second.cooldownMs],
    [REQUEST_REJECTED_COOLDOWNS_MS[0], REQUEST_REJECTED_COOLDOWNS_MS[1]]
  );
  assert.equal(second.escalate, false);
  assert.equal(third.streak, 3);
  assert.equal(third.escalate, true, "third refusal within the window escalates");
  assert.equal(third.cooldownMs, 0, "terminal state replaces the cooldown");

  // Escalation clears the streak: a reconnected connection starts from 1.
  const afterBan = recordRequestRejected("conn-a", t0 + 21 * MIN);
  assert.equal(afterBan.streak, 1);
  assert.equal(afterBan.escalate, false);
});

test("a refusal after the window expired starts a new streak", () => {
  const t0 = 1_000_000;
  recordRequestRejected("conn-a", t0);
  recordRequestRejected("conn-a", t0 + 10 * MIN);
  const late = recordRequestRejected("conn-a", t0 + REQUEST_REJECTED_WINDOW_MS + 1);
  assert.equal(late.streak, 1, "sporadic refusals (one an hour or rarer) never accumulate");
  assert.equal(late.escalate, false);
  assert.equal(late.cooldownMs, 5 * MIN);
});

test("the window is anchored at the first refusal, not the last one", () => {
  const t0 = 1_000_000;
  recordRequestRejected("conn-a", t0);
  recordRequestRejected("conn-a", t0 + 40 * MIN);
  // 65 min after the first refusal: outside the window even though the second
  // refusal was only 25 min ago → new streak, no escalation.
  const v = recordRequestRejected("conn-a", t0 + 65 * MIN);
  assert.equal(v.streak, 1);
  assert.equal(v.escalate, false);
});

test("streaks are per connection", () => {
  const t0 = 1_000_000;
  recordRequestRejected("conn-a", t0);
  recordRequestRejected("conn-a", t0 + MIN);
  const other = recordRequestRejected("conn-b", t0 + 2 * MIN);
  assert.equal(other.streak, 1);
  const a = recordRequestRejected("conn-a", t0 + 3 * MIN);
  assert.equal(a.escalate, true);
});

test("clearRequestRejectedStreak forgets the connection", () => {
  const t0 = 1_000_000;
  recordRequestRejected("conn-a", t0);
  recordRequestRejected("conn-a", t0 + MIN);
  clearRequestRejectedStreak("conn-a");
  const v = recordRequestRejected("conn-a", t0 + 2 * MIN);
  assert.equal(v.streak, 1);
});
