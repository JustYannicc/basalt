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
  freshness: "fresh",
  readingFailed: false,
  nextReadAt: null,
  earliestResetAt: null,
  bankedResets: null,
};
const sites = [{ id: "codex", site: "chatgpt.com" }];

test("a healthy pool account reads as its plan and usage windows, with no state badge", () => {
  assert.deepEqual(accountStatus(account, sites), {
    accountInfo: {
      displayName: "person@example.test",
      email: "person@example.test",
      avatarUrl: "https://integrations.sh/logo/chatgpt.com?sz=64",
    },
    status: {
      badges: [{ label: "Plus", tone: "neutral" }],
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

test("reset credits use the five-hour meter, with expiry or a bounded fallback badge; zero shows nothing", () => {
  const codex = accountStatus({ ...account, bankedResets: { available: 2, nextExpiresAt: "2030-01-05T00:00:00Z" } }, sites, new Date("2030-01-02T00:00:00Z")).status;
  assert.equal(codex.meters[0]!.detail, "↻ 2 banked · next expires in 3 days");
  const claude = accountStatus({ ...account, provider: "claude", windows: [], bankedResets: { available: 2, nextExpiresAt: null } }, sites).status;
  assert.ok(claude.badges.some((badge) => badge.label === "2 banked resets"));
  assert.equal(claude.meters.length, 0);
  const none = accountStatus({ ...account, bankedResets: { available: 0, nextExpiresAt: null } }, sites).status;
  assert.equal(none.meters[0]!.detail, undefined);
  assert.equal(accountStatus({ ...account, windows: [], bankedResets: { available: 0, nextExpiresAt: null } }, sites).status.badges.length, 1);
});

test("only a failed reading shows a warning badge, within host limits", () => {
  assert.deepEqual(accountStatus({ ...account, freshness: "stale" }, sites).status.badges, [{ label: "Plus", tone: "neutral" }]);
  const failed = accountStatus({ ...account, readingFailed: true, freshness: "fresh" }, sites).status;
  assert.ok(failed.badges.some((badge) => badge.label === "Usage reading failed" && badge.tone === "warning"));
  const full = accountStatus({ ...account, readingFailed: true, bankedResets: { available: 2, nextExpiresAt: null } }, sites).status;
  assert.ok(full.badges.length <= 8);
  assert.ok(full.meters.length <= 4);
  assert.ok(full.badges.every((badge) => badge.label.length <= 96));
});

test("pool refusals map to the host's check failures", () => {
  assert.equal(checkFailure("unauthorized"), "unauthorized");
  assert.equal(checkFailure("missing"), "unauthorized");
  assert.equal(checkFailure("not_found"), "unauthorized");
  assert.equal(checkFailure("not_owner"), "forbidden");
  assert.equal(checkFailure("busy"), "rate_limited");
  assert.equal(checkFailure("backend_unavailable"), "unavailable");
});
