import assert from "node:assert/strict";
import { test } from "node:test";
import { poolPicks, teamsOf } from "./pool-choices.ts";

const teams = teamsOf([{ id: "org-work", name: "Work" }, { id: "org-home", name: "Home", slug: "home" }, { name: "No id" }]);

test("pools from teams the person left are dropped, and repeated pools are listed once", () => {
  const picks = poolPicks([
    { id: "app-mine", name: "Ada's pool", mine: true, organization: "org-work" },
    { id: "app-scratch-1", name: "", mine: true, organization: "org-deleted" },
    { id: "app-mine", name: "Ada's pool", mine: true, organization: "org-work" },
    { id: "app-scratch-2", name: "", mine: true, organization: "org-gone" },
  ], teams);
  assert.deepEqual(picks, [{ id: "app-mine", name: "Ada's pool", mine: true, label: "Ada's pool · Work" }]);
});

test("every label names the pool and its team, and labels stay distinct", () => {
  const picks = poolPicks([
    { id: "a", name: "", mine: true, organization: "org-work" },
    { id: "b", name: "Shared GPUs", mine: false, organization: "org-home" },
    { id: "c", name: "Team pool", mine: false, organization: "org-work" },
    { id: "d", name: "Team pool", mine: false, organization: "org-work" },
  ], teams);
  assert.deepEqual(picks.map((pick) => pick.label),
    ["Your pool · Work", "Shared GPUs · Home", "Team pool · Work (1)", "Team pool · Work (2)"]);
  assert.equal(new Set(picks.map((pick) => pick.label)).size, picks.length);
});

test("without the team list, pools stay listed under their own names", () => {
  assert.deepEqual(poolPicks([
    { id: "a", name: "", mine: true, organization: "org-work" },
    { id: "b", name: "Shared", mine: false },
  ], undefined).map((pick) => pick.label), ["Your pool", "Shared"]);
});

test("a pool Worker answer with a malformed team is refused", () => {
  assert.throws(() => poolPicks([{ id: "a", name: "", mine: true, organization: 7 }], teams), /invalid pools/);
});
