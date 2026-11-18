// Where a banked reset is counted and spent: only on the window it refills, so a press on one
// limit never spends a reset that refills another.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resetPlacement } from "../../../.upstream/packages/ui/src/implementation/dashboard/account-observation-text.ts";

const window = (id: string, seconds: number, model?: string) => ({
  id,
  label: id,
  observedAt: "2026-11-18T20:00:00Z",
  measure: { unit: "%", remainingRatio: 0.5 },
  period: { mode: "fixed" as const, seconds },
  ...(model === undefined ? {} : { scope: { kind: "model", id: model } }),
});
const claude = [
  window("five_hour", 18_000),
  window("seven_day", 604_800),
  window("fable", 604_800, "fable"),
];
const account = { kind: "account" } as const;

test("each kind of reset sits on the window it refills", () => {
  assert.equal(resetPlacement({ kind: "weekly", scope: account }, claude), "seven_day");
  assert.equal(resetPlacement({ kind: "full", scope: account }, claude), "seven_day");
  assert.equal(resetPlacement({ kind: "session", scope: account }, claude), "five_hour");
  assert.equal(
    resetPlacement({ kind: "model", scope: { kind: "model", id: "fable" } }, claude),
    "fable",
  );
  // Codex says only that a reset is the account's; it refills the account's longest window.
  assert.equal(resetPlacement({ kind: "unknown", scope: account }, claude), "seven_day");
});

test("a reset whose window or scope is unknown has no place, so no window can spend it", () => {
  assert.equal(
    resetPlacement({ kind: "model", scope: { kind: "model", id: "spark" } }, claude),
    undefined,
  );
  assert.equal(resetPlacement({ kind: "unknown", scope: { kind: "unknown" } }, claude), undefined);
  const weeklyOnly = [window("seven_day", 604_800)];
  assert.equal(resetPlacement({ kind: "session", scope: account }, weeklyOnly), undefined);
  assert.equal(
    resetPlacement({ kind: "model", scope: { kind: "model", id: "fable" } }, weeklyOnly),
    undefined,
  );
});

test("an account reset never sits on a model window or a window it doesn't refill", () => {
  const modelOnly = [window("fable", 604_800, "fable")];
  assert.equal(resetPlacement({ kind: "weekly", scope: account }, modelOnly), undefined);
  assert.equal(resetPlacement({ kind: "unknown", scope: account }, modelOnly), undefined);
  const fiveHourOnly = [window("five_hour", 18_000)];
  assert.equal(resetPlacement({ kind: "weekly", scope: account }, fiveHourOnly), undefined);
  assert.equal(resetPlacement({ kind: "full", scope: account }, fiveHourOnly), undefined);
});

test("a reporter that names no periods keeps the longest-window rule for weekly resets", () => {
  const unnamed = [
    { id: "weekly", label: "Weekly", observedAt: "2026-11-18T20:00:00Z", measure: { unit: "%" } },
  ];
  assert.equal(resetPlacement({ kind: "weekly", scope: account }, unnamed), "weekly");
  assert.equal(resetPlacement({ kind: "session", scope: account }, unnamed), undefined);
});

test("a source that predates kinds keeps today's place on the longest window", () => {
  assert.equal(resetPlacement({}, claude), "seven_day");
});
