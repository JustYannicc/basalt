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
  // Without a declared root restart a failed acceptance goes straight to its rollback.
  const plain = join(dir, "plain.json");
  writeFileSync(plain, "{}");
  for (const [accept, exit, smoked] of [
    ["1", 1, false],
    ["0", 0, true],
  ] as const) {
    const output = join(dir, `plain-output-${accept}`);
    const log = join(dir, `plain-smoke-${accept}`);
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
      },
      dir,
    );
    assert.equal(result.status, exit, `accept ${accept}: ${result.stderr}`);
    assert.equal(existsSync(log), smoked, `accept ${accept}: the smoke ran`);
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

test("a declared root restart reads the provider observation first, and refuses unless it reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-provider-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // The dispatcher's stand-in writes the result the case gives it and fails like a refused observe.
  writeFileSync(
    join(bin, "bun"),
    '#!/bin/sh\necho ran >> "$BUN_LOG"\nmkdir -p "$POOL_CRASH_OUTPUT_DIRECTORY"\n[ -n "$RESULT" ] && printf %s "$RESULT" > "$POOL_CRASH_OUTPUT_DIRECTORY/result.json"\nexit 1\n',
  );
  chmodSync(join(bin, "bun"), 0o755);
  const restart = join(dir, "restart.json");
  writeFileSync(restart, JSON.stringify({ acceptance: { rootRestart: { withinSeconds: 420 } } }));
  const code = join(dir, "code.json");
  writeFileSync(code, "{}");
  const run = (label: string, policy: string, packet: string, result: string) => {
    const out = join(dir, label);
    mkdirSync(out);
    const log = join(out, "bun.log");
    const summary = join(out, "summary.md");
    writeFileSync(summary, "");
    const step = runStep(
      script("Read the provider observation before a declared root restart"),
      {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        POLICY: policy,
        POOL_CRASH_PACKET: packet,
        POOL_CRASH_OUTPUT_DIRECTORY: join(out, "result"),
        GITHUB_STEP_SUMMARY: summary,
        BUN_LOG: log,
        RESULT: result,
      },
      dir,
    );
    return {
      status: step.status,
      stdout: step.stdout,
      ran: existsSync(log),
      summary: readFileSync(summary, "utf8"),
    };
  };
  const packet = JSON.stringify({ controllerCode: { candidate: "a", workerInput: "b" } });
  const reads = JSON.stringify({ providerObservation: "provider observation: reads" });
  const refused = JSON.stringify({
    providerObservation: "provider observation: does not read (provider_fetch_failed)",
  });
  // A policy that declares no restart never reads.
  assert.deepEqual(run("code", code, "", reads), {
    status: 0,
    stdout: "",
    ran: false,
    summary: "",
  });
  // A declared restart needs the serving Worker's controller code.
  const missing = run("missing", restart, "", reads);
  assert.equal(missing.status, 1);
  assert.equal(missing.ran, false);
  assert.match(missing.stdout, /needs the serving_controller input/u);
  // It reads: the release goes on, whatever the observe reads after it said.
  const ok = run("reads", restart, packet, reads);
  assert.equal(ok.status, 0);
  assert.equal(ok.summary, "provider observation: reads\n");
  // It does not read, or the dispatcher left nothing: the release stops before its plan.
  const no = run("refused", restart, packet, refused);
  assert.equal(no.status, 1);
  assert.match(
    no.stdout,
    /^::error::provider observation: does not read \(provider_fetch_failed\): the heal would stop the root without restarting it\.$/mu,
  );
  const none = run("none", restart, packet, "");
  assert.equal(none.status, 1);
  assert.match(
    none.stdout,
    /^::error::provider observation: not read, the dispatcher left no result/mu,
  );
});
