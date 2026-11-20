import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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

test("a healing release's acceptance runs the app smoke whatever the pool found; others roll back first", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-accept-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // Stand-ins for the entry and the smoke: each exits with the code the case gives it, and the
  // entry records its arguments, so the test sees which branch of the step ran.
  writeFileSync(join(bin, "bun"), '#!/bin/sh\necho "$@" >> "$ACCEPT_ARGS"\nexit "$ACCEPT_RC"\n');
  writeFileSync(join(bin, "node"), '#!/bin/sh\necho ran >> "$SMOKE_LOG"\nexit "$SMOKE_RC"\n');
  chmodSync(join(bin, "bun"), 0o755);
  chmodSync(join(bin, "node"), 0o755);
  const policy = join(dir, "policy.json");
  writeFileSync(
    policy,
    JSON.stringify({ acceptance: { rootRestart: { bound: "healingAcceptanceWithinMs" } } }),
  );
  for (const [accept, smoke, exit] of [
    ["3", "0", 3],
    ["0", "1", 1],
    ["1", "0", 1],
    ["0", "0", 0],
  ] as const) {
    const output = join(dir, `output-${accept}-${smoke}`);
    const log = join(dir, `smoke-${accept}-${smoke}`);
    const args = join(dir, `accept-${accept}-${smoke}`);
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
        ACCEPT_ARGS: args,
      },
      dir,
    );
    assert.equal(result.status, exit, `accept ${accept}, smoke ${smoke}: ${result.stderr}`);
    assert.equal(readFileSync(log, "utf8"), "ran\n", "the smoke ran");
    assert.equal(readFileSync(output, "utf8"), `smoke=${smoke}\n`);
    // The healing branch ran: a declared root restart, with the apply's outcome passed on.
    assert.equal(
      readFileSync(args, "utf8"),
      "scripts/release/deploy.ts accept --stage production --expect restart --serving .local/release/serving.json --apply any --root-boot .local/release/root-boot.json --out .local/release/acceptance.json\n",
    );
  }
  // Without a declared root restart a failed acceptance goes straight to its rollback.
  const plain = join(dir, "plain.json");
  writeFileSync(plain, "{}");
  for (const [accept, exit, smoked] of [
    ["1", 1, false],
    ["0", 0, true],
  ] as const) {
    const output = join(dir, `plain-output-${accept}`);
    const log = join(dir, `plain-smoke-${accept}`);
    const args = join(dir, `plain-accept-${accept}`);
    writeFileSync(output, "");
    const result = runStep(
      script("Accept the release through the live pool"),
      {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        POLICY: plain,
        GITHUB_OUTPUT: output,
        ACCEPT_RC: accept,
        SMOKE_RC: "0",
        SMOKE_LOG: log,
        ACCEPT_ARGS: args,
      },
      dir,
    );
    assert.equal(result.status, exit, `accept ${accept}: ${result.stderr}`);
    assert.equal(existsSync(log), smoked, `accept ${accept}: the smoke ran`);
    assert.equal(
      readFileSync(args, "utf8"),
      "scripts/release/deploy.ts accept --stage production --expect any --root-boot .local/release/root-boot.json --out .local/release/acceptance.json\n",
      "no declared restart",
    );
  }
});

test("a declared root restart's boot read lets the pool not answer; others need its boot", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-boot-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "bun"), '#!/bin/sh\necho "$@" >> "$BOOT_ARGS"\n');
  chmodSync(join(bin, "bun"), 0o755);
  for (const [policy, extra] of [
    [
      { acceptance: { rootRestart: { bound: "healingAcceptanceWithinMs" } } },
      " --allow-not-serving",
    ],
    [{}, ""],
  ] as const) {
    const file = join(dir, `policy-${extra.length}.json`);
    const args = join(dir, `boot-${extra.length}`);
    writeFileSync(file, JSON.stringify(policy));
    const result = runStep(
      script("Record the root's boot before the apply"),
      { PATH: `${bin}:${process.env.PATH ?? ""}`, POLICY: file, BOOT_ARGS: args },
      dir,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(args, "utf8"),
      `scripts/release/deploy.ts boot --stage production --out .local/release/root-boot.json${extra}\n`,
    );
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
  assert.match(run({ outcome: "not-serving" }, "failure", "1"), /^::error::NOT SERVING/mu);
  // No record, or one without an outcome, means nobody read the pool: it never says not serving.
  for (const record of [undefined, {}]) {
    const unread = run(record, "failure", "");
    assert.match(unread, /^::error::NOT CHECKED.*the apply failed.*smoke did not run/mu);
    assert.doesNotMatch(unread, /NOT SERVING/u);
  }
});
