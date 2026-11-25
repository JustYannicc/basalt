/**
 * The repository is public, and so are the workflow's logs. With a planted account id and token,
 * no path of a scratch run prints either, nor the registry repository that holds the account id:
 * not the read-back, not a refusal, not a provider or runtime failure.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { operate, publicFailure } from "./operate.ts";
import type { Mode } from "./settings.ts";
import { fakeCloudflare, type FakeOptions } from "./test/fake-cloudflare.ts";

const stage = "test-route-scratch-1" as const;
const planted = "acct0planted0d1e2f3a4b5c";
const plantedToken = "tok0planted0secret";
const forbidden = [planted, plantedToken, "scratch-sub"];

/** Runs one operation and returns everything it would print, its failure included. */
async function printed(
  mode: Mode,
  options: FakeOptions,
  { deployFrom = "full", stackFails = false } = {},
) {
  const fake = fakeCloudflare({ accountId: planted, ...options });
  const account = { ...fake.account, token: plantedToken };
  if (deployFrom === "empty") {
    fake.applications.splice(0);
    fake.scripts.splice(0);
    fake.repositories.get(`${planted}/basalt-route-scratch-1-route-gateway`)!.clear();
  }
  const lines: string[] = [];
  try {
    await operate(stage, mode, {
      account,
      stack: async (action) => {
        if (stackFails)
          throw new Error(`The scratch stack's ${action} failed; no provider output was published`);
        if (action === "deploy") {
          fake.applications.push({ id: "app-1", name: "basalt-route-scratch-1-route-gateway" });
          fake.scripts.push({ id: "basalt-route-scratch-1-pool" });
        }
      },
      checks: async () => ({ "the stage answers": true, "sign-in completes": false }),
      log: (line) => lines.push(line),
    });
  } catch (error) {
    lines.push(publicFailure(error, [planted, plantedToken]));
    // Only a runtime connection error quotes its URL; every message this code builds must be clean
    // before redaction too, which stays a second line of defence.
    if (!options.reset) lines.push(error instanceof Error ? error.message : String(error));
  }
  return lines;
}

const assertClean = (lines: string[], what: string) => {
  for (const line of lines)
    for (const secret of forbidden)
      assert.ok(!line.includes(secret), `${what} printed a secret value: ${line}`);
};

test("the read-back and the checks print counts, kinds and pass or fail only", async () => {
  assertClean(await printed("destroy", {}), "destroy");
  assertClean(await printed("destroy", { refuseImageDelete: true }), "destroy with an image left");
  assertClean(await printed("deploy", {}), "deploy onto leftovers");
  assertClean(await printed("deploy", {}, { deployFrom: "empty" }), "deploy");
  assertClean(await printed("run", {}, { deployFrom: "empty" }), "run");
  assertClean(
    await printed("deploy", {}, { deployFrom: "empty", stackFails: true }),
    "stack failure",
  );
  assertClean(await printed("destroy", {}, { stackFails: true }), "stack destroy failure");
});

test("no provider or runtime failure on any request prints the account", async () => {
  const requests = [
    /containers\/applications/u,
    /durable_objects/u,
    /workers\/scripts/u,
    /workers\/subdomain/u,
    /registries\/.*\/credentials/u,
    /_catalog/u,
    /tags\/list/u,
    /manifests/u,
  ];
  for (const match of requests)
    for (const [label, options] of [
      ["refused", { refuse: { match, status: 500 } }],
      ["garbled", { garble: match }],
      ["reset", { reset: match }],
    ] as const)
      for (const mode of ["destroy", "deploy", "run"] as const) {
        const lines = await printed(mode, options, {
          deployFrom: mode === "destroy" ? "full" : "empty",
        });
        assertClean(lines, `${mode} with ${match} ${label}`);
      }
});

test("a failure is published as one redacted line, whatever raised it", () => {
  const raised = new TypeError(
    `fetch failed: GET https://registry.cloudflare.com/v2/${planted}/basalt-route-scratch-1-route-gateway/tags/list\n    at ${plantedToken}`,
  );
  const line = publicFailure(raised, [planted, plantedToken]);
  assertClean([line], "publicFailure");
  assert.match(line, /\[redacted\]/u);
  assert.equal(line.split("\n").length, 1);
});

test("the entry prints a refusal without the account it was given", () => {
  const run = spawnSync(process.execPath, [new URL("./run.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH,
      CLOUDFLARE_ACCOUNT_ID: planted,
      CLOUDFLARE_API_TOKEN: plantedToken,
      // Refused by the guard before any request: this test sends nothing anywhere.
      ROUTE_SCRATCH_STAGE: "test-route-scratch-1",
      ROUTE_SCRATCH_MODE: "deploy",
      ROUTE_SCRATCH_GO: "coordinator-2026-11-25-p2rg",
    },
    encoding: "utf8",
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /route_scratch_outside_actions/u);
  assertClean([run.stdout, run.stderr], "run.ts");
});

test("no workflow step traces commands or prints the environment", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/route-scratch.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workflow, /set -x|set -o xtrace|printenv|\benv\s*$|\bexport -p\b/mu);
  // The only echoes: the gate's checked outputs, and the unbuilt stage's refusal.
  const echoes = [...workflow.matchAll(/^\s*(echo .*)$/gmu)].map((match) => match[1]);
  assert.deepEqual(echoes, [
    'echo "stage=$ROUTE_SCRATCH_STAGE" >> "$GITHUB_OUTPUT"',
    'echo "mode=$ROUTE_SCRATCH_MODE" >> "$GITHUB_OUTPUT"',
    'echo "test-route-scratch-2 is not built yet"',
  ]);
  // Secrets reach only the steps that call Cloudflare, never the gate.
  const gate = /^ {2}gate:\n([\s\S]*?)^ {2}[a-z-]+:\n/mu.exec(workflow)?.[1] ?? "";
  assert.doesNotMatch(gate, /secrets\./u);
});
