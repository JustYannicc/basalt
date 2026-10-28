import assert from "node:assert/strict";
import { test } from "node:test";
import { accountStatus, checkFailure } from "./account-status.ts";
import type { Account } from "./contract.ts";

const account: Account = {
  id: "acc-1",
  provider: "codex",
  label: "person@example.test",
  plan: "Plus",
  state: "active",
  message: null,
  windows: [
    { id: "5h", label: "5 hours", remainingRatio: 0.4, resetAt: "2030-01-02T03:04:05.123456+00:00", windowSeconds: 18_000 },
    { id: "week", label: "Weekly", remainingRatio: null, resetAt: null, windowSeconds: null },
  ],
  observedAt: "2030-01-02T00:00:00Z",
};
const sites = [{ id: "codex", site: "chatgpt.com" }];

test("a pool account reads as its plan, availability and usage windows", () => {
  assert.deepEqual(accountStatus(account, sites), {
    accountInfo: {
      displayName: "person@example.test",
      email: "person@example.test",
      avatarUrl: "https://integrations.sh/logo/chatgpt.com?sz=64",
    },
    status: {
      badges: [
        { label: "Plus", tone: "neutral" },
        { label: "Available", tone: "good" },
      ],
      meters: [
        { label: "5 hours", remaining: 0.4, resetsAt: "2030-01-02T03:04:05.123Z" },
        { label: "Weekly", remaining: null },
      ],
      stats: [],
    },
  });
});

test("the status stays within the host's display limits", () => {
  const status = accountStatus(
    {
      ...account,
      plan: "  ",
      state: "error",
      message: "x".repeat(300),
      windows: Array.from({ length: 6 }, (_, index) => ({
        id: String(index),
        label: index === 0 ? "" : "w".repeat(80),
        remainingRatio: index === 1 ? 7 : -1,
        resetAt: index === 2 ? "+010000-01-01T00:00:00Z" : "not a time",
        windowSeconds: index,
      })),
    },
    sites,
  ).status;
  assert.deepEqual(status.badges, [{ label: "Needs attention", tone: "bad" }]);
  assert.equal(status.meters.length, 4);
  assert.deepEqual(status.meters[0], { label: "Usage", remaining: 0 });
  assert.equal(status.meters[1]!.remaining, 1);
  assert.equal(status.meters[1]!.label.length, 64);
  assert.equal(status.stats[0]!.value.length, 128);
  assert.equal(status.meters[2]!.resetsAt, undefined);
});

test("windows read shortest first, and an active account shows no note", () => {
  const status = accountStatus({ ...account, message: "fine", windows: [...account.windows].reverse() }, sites).status;
  assert.deepEqual(status.meters.map((meter) => meter.label), ["5 hours", "Weekly"]);
  assert.deepEqual(status.stats, []);
  assert.deepEqual(accountStatus({ ...account, state: "disabled" }, sites).status.badges.at(-1), { label: "Paused", tone: "warning" });
});

test("pool refusals map to the host's check failures", () => {
  assert.equal(checkFailure("unauthorized"), "unauthorized");
  assert.equal(checkFailure("missing"), "unauthorized");
  assert.equal(checkFailure("not_found"), "unauthorized");
  assert.equal(checkFailure("not_owner"), "forbidden");
  assert.equal(checkFailure("busy"), "rate_limited");
  assert.equal(checkFailure("backend_unavailable"), "unavailable");
});
