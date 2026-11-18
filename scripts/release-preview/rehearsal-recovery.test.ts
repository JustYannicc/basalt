import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReleaseOutcome } from "./rehearsal-plan.ts";
import { requireAbortedPrior, resumeSteps, rollbackSteps, type RecoveryHooks } from "./rehearsal-recovery.ts";

function world(outcomes: Record<string, ReleaseOutcome>, overrides: Partial<RecoveryHooks> = {}) {
  const events: string[] = [];
  const hooks: RecoveryHooks = {
    deployBaseline: async () => void events.push("baseline"),
    shape: async (phase, label, selection) => void events.push(`shape:${phase}:${label}:${selection}`),
    preflight: async () => (events.push("preflight"), { mutations: { deniedStateWrites: 0, blockedHttpMutations: 0, refusedBridgeRequests: {} }, steps: [{ step: "release-journal", summary: { prior: "prior-settled-or-aborted", baseline: "journal-source" } }] }),
    seedPools: async () => (events.push("seed"), { cleanPool: "clean" }),
    release: async ({ stop, commit }) => {
      const key = `${stop ?? "complete"}${commit ? `@${commit}` : ""}`;
      events.push(`release:${key}`);
      return outcomes[key] ?? (stop ? { ok: false, reason: `release-rehearsal-stopped-${stop}` } : { ok: true });
    },
    abort: async () => (events.push("abort"), { status: "aborted" }),
    nextCandidate: async () => (events.push("next"), "n".repeat(40)),
    recover: async ({ databaseCompatible }) => (events.push(`recover:${databaseCompatible}`), { ok: true }),
    serve: async () => (events.push("serve"), "served"),
    ...overrides,
  };
  return { events, hooks };
}

const run = async (steps: ReturnType<typeof resumeSteps>) => {
  await steps.deploy();
  await steps.seed();
  return steps.smoke();
};

test("resume re-dispatches the same candidate from each bind point, aborts the pending startup, then releases the next", async () => {
  const { events, hooks } = world({ complete: { ok: false, reason: "runtime-release-candidate-aborted-or-pending" } });
  const steps = resumeSteps(hooks);
  assert.equal(await run(steps), "served");
  assert.deepEqual(events.slice(3), [
    "release:after-bootstrap-blue",
    "shape:classes:after-bootstrap-blue:true",
    "release:after-bind-green",
    "shape:classes:after-bind-green:true",
    "release:before-promotion-gate",
    "abort",
    "shape:classes:aborted:true",
    "release:complete",
    "next",
    "preflight",
    `release:complete@${"n".repeat(40)}`,
    "shape:classes:next-released:false",
    "serve",
  ]);
});

test("resume refuses an abort that did not settle, and an aborted candidate that is not refused", async () => {
  await assert.rejects(run(resumeSteps(world({}, { abort: async () => ({ status: "pending" }) }).hooks)), /abort ended pending/);
  await assert.rejects(run(resumeSteps(world({}).hooks)), /aborted candidate was not refused/);
  const early = world({ "after-bind-green": { ok: true } });
  await assert.rejects(run(resumeSteps(early.hooks)), /did not stop at after-bind-green: it completed/);
});

test("rollback refuses recovery to the pre-expansion version, completes the expansion, then recovers the next release", async () => {
  let recoveries = 0;
  const { events, hooks } = world({}, {
    recover: async ({ databaseCompatible }) => {
      events.push(`recover:${databaseCompatible}`);
      recoveries += 1;
      return recoveries === 1 ? { ok: false, reason: "declared-class-recovery-export-missing" } : { ok: true };
    },
  });
  assert.equal(await run(rollbackSteps(hooks)), "served");
  assert.deepEqual(events.slice(3), [
    "release:after-controller",
    "shape:classes:after-classes:false",
    "recover:false",
    "shape:classes:after-refused-recovery:false",
    "release:after-bind-blue",
    "shape:classes:after-bind-blue:true",
    "release:after-bootstrap-green",
    "shape:classes:after-bootstrap-green:true",
    "release:complete",
    "next",
    `release:after-controller@${"n".repeat(40)}`,
    "recover:true",
    "shape:classes:after-recovery:false",
    "serve",
  ]);
});

test("rollback fails if the pre-expansion recovery is accepted or refused for another reason", async () => {
  for (const outcome of [{ ok: true }, { ok: false, reason: "declared-class-identity-changed" }] as ReleaseOutcome[])
    await assert.rejects(run(rollbackSteps(world({}, { recover: async () => outcome }).hooks)), /pre-expansion version was not refused/);
});

test("the next candidate's preflight must read the aborted prior through the journal", () => {
  const clean = { mutations: { deniedStateWrites: 0, blockedHttpMutations: 0, refusedBridgeRequests: {} } };
  requireAbortedPrior({ ...clean, steps: [{ summary: "prior-settled-or-aborted journal-source" }] });
  assert.throws(() => requireAbortedPrior({ ...clean, steps: [{ summary: "prior-settled-or-aborted" }] }), /journal/);
  assert.throws(() => requireAbortedPrior(clean), /aborted prior/);
  assert.throws(() => requireAbortedPrior({ ...clean, fatal: "x", steps: [{ summary: "prior-settled-or-aborted journal-source" }] }), /fatally/);
});
