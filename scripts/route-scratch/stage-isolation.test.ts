/**
 * The route scratch stages and the repo's stage-sweeping tools can never take each other's stages.
 * (a) Nothing that reads, tears down or retires rehearsal and preview stages matches a scratch
 * stage or claims a name a scratch stage makes. (b) The scratch workflow can never run on a
 * rehearsal or preview stage.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { alchemyPreviewStateReader } from "../preview/inventory.ts";
import { isRehearsalStage, stageOwnsName } from "../release/rehearsal-stage.ts";
import { stageRepositories } from "../release/stage-teardown.ts";
import { gatewayName, prefix, refusal, stages, workerName } from "./settings.ts";

const rehearsals = [
  ...Array.from({ length: 9 }, (_, index) => `test-rehearsal-${index + 1}`),
  // The four-digit stages from before rehearsals ran on lanes, which a stage retire takes.
  "test-rehearsal-1000",
  "test-rehearsal-2026",
  "test-rehearsal-9999",
];
const previews = ["test-pr-1", "test-pr-1951", "test-pr-99999"];

/** Every name a scratch stage makes, including Alchemy's container and image names for it. */
function scratchNames(stage: (typeof stages)[number]) {
  const physical = (id: string) =>
    `basalt-route-scratch-${id.toLowerCase()}-${stage}-abcdefghijklmnop`;
  return [
    workerName(stage),
    gatewayName(stage),
    `${prefix(stage)}-pool`,
    physical("RouteGateway"),
    physical("Pool"),
    // The same shapes with a rehearsal stage spelled inside, which only a prefix match would take.
    `${prefix(stage)}-test-rehearsal-1-pool-runtime-blue`,
  ];
}

test("no rehearsal or preview tool treats a scratch stage as its own", () => {
  for (const stage of stages) {
    assert.equal(isRehearsalStage(stage), false, stage);
    // A teardown asked for a scratch stage takes nothing at all.
    assert.equal(stageOwnsName(workerName(stage), stage), false);
    assert.deepEqual(stageRepositories([`acct/${gatewayName(stage)}`], "acct", stage), []);
  }
});

test("no rehearsal teardown or retire claims a name a scratch stage makes", () => {
  for (const stage of stages)
    for (const rehearsal of rehearsals)
      for (const name of scratchNames(stage)) {
        assert.equal(stageOwnsName(name, rehearsal), false, `${rehearsal} would take ${name}`);
        assert.deepEqual(stageRepositories([`acct/${name}`], "acct", rehearsal), []);
      }
});

test("the preview state reader refuses a scratch stage before reading anything", async () => {
  let ran = false;
  const reader = alchemyPreviewStateReader({
    command: (() => {
      ran = true;
      throw new Error("no state command may run");
    }) as never,
    environment: {},
  });
  for (const stage of stages) await assert.rejects(reader.read(stage), /restricted to PR stages/u);
  assert.equal(ran, false);
});

test("the scratch guard refuses every rehearsal and preview stage", () => {
  const dispatch = {
    GITHUB_ACTIONS: "true",
    GITHUB_REF: "refs/heads/main",
    ROUTE_SCRATCH_MODE: "deploy",
    ROUTE_SCRATCH_GO: "coordinator-2026-11-25-p2rg-1",
  };
  for (const stage of [...rehearsals, ...previews, "production", "scale-180"])
    assert.equal(
      refusal({ ...dispatch, ROUTE_SCRATCH_STAGE: stage }),
      "route_scratch_stage_refused",
      stage,
    );
});

test("the scratch workflow offers only its two stages and has no other trigger", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/route-scratch.yml", import.meta.url),
    "utf8",
  );
  const triggers = /^on:\n((?: {2}.*\n|\n)*)/mu.exec(workflow)?.[1] ?? "";
  const events = [...triggers.matchAll(/^ {2}([a-z_]+):/gmu)].map((match) => match[1]);
  assert.deepEqual(events, ["workflow_dispatch"]);
  const options = [...workflow.matchAll(/^\s+options: \[(.*)\]$/gmu)].map((match) => match[1]);
  assert.ok(
    options.includes(stages.join(", ")),
    "the stage input offers exactly the scratch stages",
  );
  for (const stage of [...rehearsals, ...previews]) assert.ok(!workflow.includes(stage), stage);
  // The stage reaches each job only through the gate's checked output.
  assert.match(workflow, /^ {2}gate:\n/mu);
  for (const job of ["stage-1", "stage-2"])
    assert.match(workflow, new RegExp(`^ {2}${job}:\\n {4}needs: gate\\n`, "mu"), job);
});
