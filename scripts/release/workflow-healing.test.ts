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
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runCrashDispatch } from "../pool-crash-dispatch.ts";

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

test("acceptance that could not test says so to the steps after it, and still ends the step red", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-untested-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "bun"), '#!/bin/sh\nexit "$ACCEPT_RC"\n');
  writeFileSync(join(bin, "node"), '#!/bin/sh\necho ran >> "$SMOKE_LOG"\nexit 0\n');
  chmodSync(join(bin, "bun"), 0o755);
  chmodSync(join(bin, "node"), 0o755);
  const healing = join(dir, "healing.json");
  writeFileSync(
    healing,
    JSON.stringify({ acceptance: { rootRestart: { bound: "healingAcceptanceWithinMs" } } }),
  );
  const plain = join(dir, "plain.json");
  writeFileSync(plain, "{}");
  for (const [policy, accept, output] of [
    [plain, "4", "acceptance=could-not-test\n"],
    [healing, "4", "acceptance=could-not-test\nsmoke=0\n"],
    [plain, "1", ""],
    [healing, "1", "smoke=0\n"],
  ] as const) {
    const label = `${policy === plain ? "plain" : "healing"}-${accept}`;
    const file = join(dir, `output-${label}`);
    writeFileSync(file, "");
    const result = runStep(
      script("Accept the release through the live pool"),
      {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        POLICY: policy,
        GITHUB_OUTPUT: file,
        ACCEPT_RC: accept,
        SMOKE_LOG: join(dir, `smoke-${label}`),
      },
      dir,
    );
    assert.equal(result.status, Number(accept), `${label}: ${result.stderr}`);
    assert.equal(readFileSync(file, "utf8"), output, label);
  }
  // After a rollback, the read of the version rolled back to says which of the two it was.
  writeFileSync(join(bin, "bun"), '#!/bin/sh\n[ "$2" = accept ] && exit "$ACCEPT_RC"\nexit 0\n');
  for (const [accept, said] of [
    [
      "4",
      /could not test the rolled-back version: the release's acceptance device hit its user's cap/u,
    ],
    ["1", /The rolled-back version also fails acceptance/u],
  ] as const) {
    const rolled = runStep(
      script("Roll back a failed release"),
      { PATH: `${bin}:${process.env.PATH ?? ""}`, ACCEPT_RC: accept },
      dir,
    );
    assert.equal(rolled.status, 1, "a rollback ends red");
    assert.match(rolled.stdout, said, accept);
    // The re-accept ran admitted, so exit 4 is only ever the cap, never a registration.
    assert.doesNotMatch(rolled.stdout, /still registered/u, accept);
  }
  const stop = runStep(script("Stop on an acceptance that could not test"), {}, dir);
  assert.equal(stop.status, 1, "the run is never green");
  assert.match(stop.stdout, /^::error::ACCEPTANCE COULD NOT TEST.*hit its user's cap/mu);
  assert.doesNotMatch(stop.stdout, /still registered/u);
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
  const untested = run({ outcome: "could-not-test" }, "success", "0");
  assert.match(untested, /^::error::COULD NOT TEST/mu);
  assert.match(untested, /the release's acceptance device hit its user's cap: check the cap/u);
  assert.doesNotMatch(untested, /NOT SERVING|still registered/u);
  // Every model call served, but no boot was read before the release to show the root restarted.
  const unconfirmed = run(
    { outcome: "serving-restart-unconfirmed", restart: { ready: true } },
    "success",
    "0",
  );
  assert.match(
    unconfirmed,
    /^::error::SERVING, RESTART UNCONFIRMED: the root's boot before the release could not be read/mu,
  );
  assert.match(unconfirmed, /the apply succeeded and the public app smoke passed/u);
  assert.doesNotMatch(unconfirmed, /HEALED|NOT SERVING|NOT CHECKED/u);
  // No record, or one without an outcome, means nobody read the pool: it never says not serving.
  for (const record of [undefined, {}]) {
    const unread = run(record, "failure", "");
    assert.match(unread, /^::error::NOT CHECKED.*the apply failed.*smoke did not run/mu);
    assert.doesNotMatch(unread, /NOT SERVING/u);
  }
});

test("a declared root restart reads the provider twice first, and refuses unless both read", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-provider-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // The dispatcher's stand-in writes the result the case gives it and fails like a refused observe.
  writeFileSync(
    join(bin, "bun"),
    '#!/bin/sh\necho ran >> "$BUN_LOG"\nmkdir -p "$POOL_CRASH_OUTPUT_DIRECTORY"\n[ -n "$RESULT" ] && printf %s "$RESULT" | sed "s/@REQUEST@/$POOL_CRASH_REQUEST_ID/g" > "$POOL_CRASH_OUTPUT_DIRECTORY/result.json"\nexit 1\n',
  );
  chmodSync(join(bin, "bun"), 0o755);
  // The real policy file, so a renamed field in its schema cannot switch this step off unseen.
  const restart = fileURLToPath(new URL("policies/code-restart.json", import.meta.url));
  const code = join(dir, "code.json");
  writeFileSync(code, "{}");
  const temporary = join(dir, "runner-temp");
  mkdirSync(temporary);
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
        POOL_CRASH_TEMPORARY_DIRECTORY: temporary,
        GO_INPUT: "GO: replace the pool Worker <now>, for example",
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
  const token = "provider observation: reads";
  const passes = "restart read: passes";
  // The stand-in writes the request id the step generated wherever a result says @REQUEST@.
  const lines = (
    providerObservation?: string,
    restartObservation?: string,
    error?: string,
    requestId = "@REQUEST@",
  ) => JSON.stringify({ requestId, providerObservation, restartObservation, error });
  const refuses = (label: string, result: string) => {
    const outcome = run(label, restart, packet, result);
    assert.equal(outcome.status, 1, label);
    return outcome.stdout;
  };
  // A policy that declares no restart never reads.
  assert.deepEqual(run("code", code, "", lines(token, passes)), {
    status: 0,
    stdout: "",
    ran: false,
    summary: "",
  });
  // A declared restart needs the serving Worker's controller code.
  const missing = run("missing", restart, "", lines(token, passes));
  assert.equal(missing.status, 1);
  assert.equal(missing.ran, false);
  assert.match(missing.stdout, /needs the serving_controller input/u);
  // Both read: the release goes on, whatever the observe reads after them said. The summary keeps
  // the two lines apart and names what was not checked.
  const ok = run("reads", restart, packet, lines(token, passes));
  assert.equal(ok.status, 0);
  const [first, second, gaps, go, ...rest] = ok.summary.split("\n");
  assert.deepEqual([first, second, rest], [token, passes, [""]]);
  assert.match(gaps!, /lists the application's instances/u);
  assert.match(gaps!, /seen only if it also moved the application version/u);
  // The release's own GO is kept in the summary, whatever words it uses.
  assert.equal(go, "Release GO: GO: replace the pool Worker <now>, for example");
  // The token read refuses: by the provider, or because the Worker refused the packet's identity.
  assert.match(
    refuses("fetch", lines("provider observation: does not read (provider_fetch_failed)", passes)),
    /^::error::provider observation: does not read \(provider_fetch_failed\): the heal would stop the root without restarting it\.$/mu,
  );
  const identity = refuses(
    "identity",
    lines("provider observation: does not read (controller_identity)", passes),
  );
  assert.match(
    identity,
    /^::error::.*controller_identity.*The controller code in serving_controller does not match the serving Worker/mu,
  );
  assert.doesNotMatch(identity, /heal would stop/u);
  // The token reads but the restart's own first read would not.
  assert.match(
    refuses("drift", lines(token, "restart read: refuses (recorded_pins_differ)")),
    /^::error::restart read: refuses \(recorded_pins_differ\): .*pins recorded when the selected runtime was admitted/mu,
  );
  assert.match(
    refuses("unselected", lines(token, "restart read: not checked (no_selected_runtime)")),
    /nothing to heal\. On a stage this passes only after the adopt\.$/mu,
  );
  assert.match(
    refuses("lost", lines(token, "restart read: does not read (outcome_unknown)")),
    /^::error::restart read: does not read \(outcome_unknown\): the heal would stop the root/mu,
  );
  assert.match(refuses("half", lines(token)), /^::error::restart read: not read: /mu);
  // Line 2 missing or not passing: the dispatcher's own public cause is printed with it.
  assert.match(
    refuses(
      "drift with a cause",
      lines(
        token,
        "restart read: refuses (recorded_pins_differ)",
        "active-health outcome unknown: runtime-handoff-response-refused (PoolRuntime) HTTP 503",
      ),
    ),
    /^::error::restart read: refuses \(recorded_pins_differ\) \(the dispatcher stopped at: active-health outcome unknown: runtime-handoff-response-refused \(PoolRuntime\) HTTP 503\): /mu,
  );
  assert.match(
    refuses("inspect", lines(token, undefined, "inspect outcome unknown: AbortError")),
    /^::error::restart read: not read \(the dispatcher stopped at: inspect outcome unknown: AbortError\): the heal would stop/mu,
  );
  assert.match(
    refuses(
      "unavailable",
      lines(
        token,
        "restart read: not checked (selection_unavailable)",
        "inspect outcome unknown: bridge exited",
      ),
    ),
    /^::error::restart read: not checked \(selection_unavailable\) \(the dispatcher stopped at: inspect outcome unknown: bridge exited\): the heal/mu,
  );
  // The dispatcher left nothing, or refused before any read: its own public cause is printed.
  assert.match(
    refuses("none", ""),
    /^::error::provider observation: not read, the dispatcher left no result/mu,
  );
  assert.match(
    refuses("early", lines(undefined, undefined, "packet must be exactly {controllerCode}")),
    /^::error::provider observation: not read, packet must be exactly \{controllerCode\}: the heal/mu,
  );
  // Only one document with both lines, each one exact string, passes.
  const both = lines(token, passes);
  for (const [label, result] of [
    ["two documents", `${both}\n${both}`],
    ["trailing newline", lines(`${token}\n`, passes)],
    ["restart trailing newline", lines(token, `${passes}\n`)],
    ["array", JSON.stringify([JSON.parse(both)])],
    ["case", lines(token.toUpperCase(), passes)],
    ["another request", lines(token, passes, undefined, crypto.randomUUID())],
  ] as const)
    assert.match(refuses(label, result), /^::error::/mu, label);
  // A line that is not one printable line is never echoed into the log.
  const injected = refuses("injected", lines(undefined, undefined, "x\n::warning::injected"));
  assert.doesNotMatch(injected, /^::warning::/mu);
  assert.match(injected, /the dispatcher left no result/u);
  // Each run reads its own fresh folder: a run that writes nothing never passes on an earlier one.
  assert.equal(run("before", restart, packet, lines(token, passes)).status, 0);
  assert.match(refuses("after", ""), /the dispatcher left no result/u);
});

test("the same provider read runs before the plan and again directly before the apply", () => {
  const all = steps as { name?: string; run?: string; env?: object; if?: string }[];
  const names = all.map((entry) => entry.name);
  const first = names.indexOf("Read the provider observation before a declared root restart");
  const again = names.indexOf("Read the provider observation again right before the apply");
  assert.ok(first >= 0 && first < names.indexOf("Plan and check"));
  assert.equal(names[again + 1], "Apply the reviewed plan");
  assert.equal(all[again]!.run, all[first]!.run);
  assert.deepEqual(all[again]!.env, all[first]!.env);
  assert.equal(all[again]!.if, "env.MODE == 'apply'");
});

test("the provider read's own go text passes the crash operator's go rule", async () => {
  const env = (
    steps.find(
      (entry) => entry.name === "Read the provider observation before a declared root restart",
    ) as { env: Record<string, string> }
  ).env;
  assert.doesNotMatch(env.POOL_CRASH_COORDINATOR_GO!, /inputs\.go/u);
  // Exactly what observe mode reads: no encryption key, and no GitHub token, which only an apply
  // reads to list earlier runs.
  assert.deepEqual(Object.keys(env).sort(), [
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "POOL_CRASH_COORDINATOR_GO",
    "POOL_CRASH_MODE",
    "POOL_CRASH_PACKET",
    "POOL_CRASH_TEMPORARY_DIRECTORY",
    "POOL_DEPLOYMENT_KEY",
  ]);
  assert.deepEqual(
    Object.values(env).flatMap((value) =>
      [...value.matchAll(/secrets\.([A-Z_]+)/gu)].map((m) => m[1]),
    ),
    ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "POOL_DEPLOYMENT_KEY"],
  );
  const go = env.POOL_CRASH_COORDINATOR_GO!.replace(/\$\{\{[^}]*\}\}/gu, "1234567890");
  // Past the go rule the dispatcher refuses this packet; nothing is read or sent.
  const unreachable = async () => {
    throw new Error("nothing is read before the packet decodes");
  };
  const result = await runCrashDispatch(
    {
      mode: "observe",
      requestId: crypto.randomUUID(),
      packet: "not json",
      coordinatorGo: go,
      accountId: "0".repeat(32),
      signingKey: "",
      ref: "refs/heads/main",
      event: "workflow_dispatch",
      runId: 1,
      runAttempt: "1",
    },
    {
      listRuns: unreachable,
      readTarget: unreachable,
      observe: unreachable,
      rootHealth: unreachable,
      resetRecovery: unreachable,
      crash: unreachable,
      sleep: async () => {},
      now: () => 1,
    },
  );
  assert.equal(result.error, "packet is not valid JSON");
});

test("in plan mode a failed provider read still lets the plan run, and the run fails after it", () => {
  const all = steps as {
    name?: string;
    id?: string;
    if?: string;
    run?: string;
    "continue-on-error"?: string;
  }[];
  const names = all.map((entry) => entry.name);
  const provider =
    all[names.indexOf("Read the provider observation before a declared root restart")]!;
  assert.equal(provider.id, "provider");
  // Only a plan continues: an apply stops at the read, before anything is planned or applied.
  assert.equal(provider["continue-on-error"], "${{ env.MODE == 'plan' }}");
  const again = all[names.indexOf("Read the provider observation again right before the apply")]!;
  assert.equal(again["continue-on-error"], undefined);
  const stop = names.indexOf("Stop on an unread provider observation");
  assert.equal(names[stop - 1], "Plan and check");
  assert.equal(
    all[stop]!.if,
    "always() && env.MODE == 'plan' && steps.provider.outcome == 'failure'",
  );
  const dir = mkdtempSync(join(tmpdir(), "release-provider-stop-"));
  const result = runStep(script("Stop on an unread provider observation"), {}, dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^::error::.*provider observation.*plan above ran for review only/mu);
});
