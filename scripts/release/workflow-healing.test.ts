import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { parse } = createRequire(new URL("../architecture/package.json", import.meta.url))("yaml");
const steps = (
  parse(readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8")) as {
    jobs: { release: { steps: { name?: string; run?: string }[] } };
  }
).jobs.release.steps;
/** A step's script as Actions runs it (`bash -e`), with each expression replaced by a value. */
const script = (name: string, expression = "any") => {
  const run = steps.find((step) => step.name === name)?.run;
  assert.ok(run, `missing step ${name}`);
  return run.replace(/\$\{\{[^}]*\}\}/gu, expression);
};
const runStep = (body: string, env: Record<string, string>, cwd: string) =>
  spawnSync("bash", ["-e", "-c", body], {
    cwd,
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });

test("a healing release's acceptance runs the app smoke whatever the pool's acceptance found", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-accept-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // Stand-ins for the entry and the smoke: each exits with the code the case gives it.
  writeFileSync(join(bin, "bun"), '#!/bin/sh\nexit "$ACCEPT_RC"\n');
  writeFileSync(join(bin, "node"), '#!/bin/sh\necho ran >> "$SMOKE_LOG"\nexit "$SMOKE_RC"\n');
  chmodSync(join(bin, "bun"), 0o755);
  chmodSync(join(bin, "node"), 0o755);
  const policy = join(dir, "policy.json");
  writeFileSync(policy, JSON.stringify({ acceptance: { rootRestart: { withinSeconds: 420 } } }));
  for (const [accept, smoke, exit] of [
    ["3", "0", 3],
    ["0", "1", 1],
    ["1", "0", 1],
    ["0", "0", 0],
  ] as const) {
    const output = join(dir, `output-${accept}-${smoke}`);
    const log = join(dir, `smoke-${accept}-${smoke}`);
    writeFileSync(output, "");
    const result = runStep(
      script("Accept the release through the live pool"),
      {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        POLICY: policy,
        GITHUB_OUTPUT: output,
        ACCEPT_RC: accept,
        SMOKE_RC: smoke,
        SMOKE_LOG: log,
      },
      dir,
    );
    assert.equal(result.status, exit, `accept ${accept}, smoke ${smoke}: ${result.stderr}`);
    assert.equal(readFileSync(log, "utf8"), "ran\n", "the smoke ran");
    assert.equal(readFileSync(output, "utf8"), `smoke=${smoke}\n`);
  }
});

test("a failed healing release names its outcome, the apply and the app smoke", () => {
  const run = (outcome: object | undefined, applyOutcome: string, smoke: string) => {
    const dir = mkdtempSync(join(tmpdir(), "release-stop-"));
    mkdirSync(join(dir, ".local/release"), { recursive: true });
    if (outcome)
      writeFileSync(join(dir, ".local/release/acceptance.json"), JSON.stringify(outcome));
    const result = runStep(
      script("Stop on a failed healing release"),
      { APPLY_OUTCOME: applyOutcome, SMOKE: smoke },
      dir,
    );
    assert.equal(result.status, 1, "the run is never green");
    return result.stdout;
  };
  // Healed with a failed apply or a failed smoke is still healed, and says what failed.
  const healed = run({ outcome: "healed" }, "failure", "0");
  assert.match(healed, /^::error::HEALED, but the run is red/mu);
  assert.match(healed, /the apply failed .* the public app smoke passed/u);
  assert.match(run({ outcome: "healed" }, "success", "1"), /HEALED.*the public app smoke FAILED/u);
  const person = run(
    { outcome: "serving-needs-person", restart: { reason: "needs a person (restart_failed)" } },
    "success",
    "0",
  );
  assert.match(person, /^::error::SERVING, NEEDS A PERSON/mu);
  assert.match(person, /needs a person \(restart_failed\)/u);
  // No record at all, or anything else, is not serving.
  assert.match(run(undefined, "failure", ""), /^::error::NOT SERVING.*smoke did not run/mu);
  assert.match(run({ outcome: "not-serving" }, "success", "0"), /^::error::NOT SERVING/mu);
});
