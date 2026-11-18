// An account row counts banked resets per kind, each on the bar it refills, with its nearest expiry
// visible; different kinds never add into one number.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as text from "../../../.upstream/packages/ui/src/implementation/dashboard/account-observation-text.ts";

const now = Date.parse("2026-11-18T20:30:00Z");
const format = { locale: "en-US", timeZone: "Europe/Zurich" };
const window = (id: string, seconds: number, model?: string) => ({
  id,
  label: id,
  observedAt: "2026-11-18T20:26:00Z",
  measure: { unit: "%", remainingRatio: 0.5 },
  period: { mode: "fixed" as const, seconds },
  ...(model === undefined ? {} : { scope: { kind: "model", id: model } }),
});
const windows = [
  window("five_hour", 18_000),
  window("seven_day", 604_800),
  window("fable", 604_800, "fable"),
];
const balance = (
  id: string,
  label: string,
  available: number,
  expiresAt: string | undefined,
  kind?: "session" | "weekly" | "full" | "model",
  model?: string,
) => ({
  id,
  label,
  unit: "resets",
  available,
  observedAt: "2026-11-18T20:26:00Z",
  ...(expiresAt === undefined ? {} : { expiresAt }),
  ...(kind === undefined
    ? {}
    : {
        reset: { kind },
        scope:
          model === undefined
            ? { kind: "account" as const }
            : { kind: "model" as const, id: model },
      }),
});
const observation = {
  offering: "subscription" as const,
  windows,
  balances: [
    balance("session-a", "5-hour resets", 1, "2026-11-19T01:10:00Z", "session"),
    balance("session-b", "5-hour resets", 1, "2026-11-20T06:00:00Z", "session"),
    balance("weekly", "Weekly resets", 1, "2026-11-23T08:00:00Z", "weekly"),
    balance("full", "Full resets", 1, "2026-11-27T17:00:00Z", "full"),
    balance("fable-a", "Fable resets", 1, "2026-11-21T13:30:00Z", "model", "fable"),
    balance("fable-b", "Fable resets", 1, "2026-12-05T07:15:00Z", "model", "fable"),
    balance("expired", "Weekly resets", 4, "2026-11-17T08:00:00Z", "weekly"),
    // A source from before kinds: no kind, scope or expiry.
    balance("legacy", "Banked resets", 2, undefined),
  ],
};

test("each kind of banked reset is its own count on the bar it refills, never summed", () => {
  assert.equal(typeof text.bankedResetKinds, "function", "the row model counts resets per kind");
  const kinds = text.bankedResetKinds(observation, windows, now, format);
  assert.deepEqual(
    kinds.map((kind) => [kind.window, kind.text, kind.expiry]),
    [
      ["five_hour", "2 five-hour", "next expires 19.11.2026 02:10"],
      ["seven_day", "1 weekly", "expires 23.11.2026 09:00"],
      ["seven_day", "1 full", "expires 27.11.2026 18:00"],
      ["seven_day", "2 banked", "expiry not reported"],
      ["fable", "2 Fable", "next expires 21.11.2026 14:30"],
    ],
  );
});

test("a line's control spends only its own kind, from the bar it sits on", () => {
  assert.equal(typeof text.spendsKind, "function", "each line decides which credits it spends");
  const kinds = text.bankedResetKinds(observation, windows, now, format);
  const line = (noun: string) => kinds.find((kind) => kind.noun === noun)!;
  const account = { kind: "account" } as const;
  const fable = { kind: "model", scope: { kind: "model", id: "fable" } } as const;
  assert.equal(text.spendsKind(line("weekly"), { kind: "weekly", scope: account }, windows), true);
  assert.equal(text.spendsKind(line("weekly"), { kind: "full", scope: account }, windows), false);
  assert.equal(text.spendsKind(line("weekly"), fable, windows), false);
  assert.equal(text.spendsKind(line("Fable"), fable, windows), true);
  assert.equal(
    text.spendsKind(line("five-hour"), { kind: "session", scope: account }, windows),
    true,
  );
  // The line of unknown kind takes the account's unclassified credits and a pool's from before
  // kinds, never a model's or a named kind's.
  assert.equal(text.spendsKind(line("banked"), { kind: "unknown", scope: account }, windows), true);
  assert.equal(text.spendsKind(line("banked"), {}, windows), true);
  assert.equal(text.spendsKind(line("banked"), { kind: "weekly", scope: account }, windows), false);
  assert.equal(text.spendsKind(line("banked"), fable, windows), false);
});

test("unclassified resets are one banked line on the longest window; a kind without its window has no line", () => {
  const codexWindows = [window("five_hour", 18_000), window("seven_day", 604_800)];
  const unknown = (
    id: string,
    available: number,
    scope: "account" | "unknown",
    expiresAt?: string,
  ) => ({
    id,
    label: "Resets with unknown scope",
    unit: "resets",
    available,
    observedAt: "2026-11-18T20:26:00Z",
    ...(expiresAt === undefined ? {} : { expiresAt }),
    reset: { kind: "unknown" as const },
    scope: { kind: scope },
  });
  const codex = {
    offering: "subscription" as const,
    windows: codexWindows,
    balances: [
      // The pool reports Codex credits with an unknown kind and scope.
      unknown("codex", 2, "unknown", "2026-11-30T18:48:00Z"),
      unknown("account", 1, "account"),
      // No Fable window is reported, so its resets have no line; Details still lists them.
      balance("fable", "Fable resets", 1, "2026-11-21T13:30:00Z", "model", "fable"),
    ],
  };
  const kinds = text.bankedResetKinds(codex, codexWindows, now, format);
  assert.deepEqual(
    kinds.map((kind) => [kind.window, kind.text, kind.expiry]),
    [["seven_day", "3 banked", "next expires 30.11.2026 19:48"]],
  );
  const [banked] = kinds;
  assert.ok(banked);
  // Codex's spend catalog names its credits the account's; Claude's unclassified grants have no
  // place, so a banked line never spends them.
  assert.equal(
    text.spendsKind(banked, { kind: "unknown", scope: { kind: "account" } }, codexWindows),
    true,
  );
  assert.equal(
    text.spendsKind(banked, { kind: "unknown", scope: { kind: "unknown" } }, codexWindows),
    false,
  );
});

test("pool counts spell the 5-hour kind as the rows do", () => {
  const session = {
    label: "5-hour resets",
    scope: { kind: "account" as const },
    reset: { kind: "session" as const },
  };
  assert.equal(text.resetCountText(session, 2), "2 five-hour resets");
  assert.equal(text.resetCountText(session, 1), "1 five-hour reset");
  assert.equal(
    text.resetCountText({ label: "Fable resets", scope: { kind: "model", id: "fable" } }, 3),
    "3 Fable resets",
  );
});
