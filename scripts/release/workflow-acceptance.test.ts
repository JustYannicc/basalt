import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

// How the release job reads acceptance's results: the real entry inside the real step scripts,
// then the exact `if:` conditions of the steps after them, evaluated with the outputs it wrote.

const repo = fileURLToPath(new URL("../../", import.meta.url));
const { parse } = createRequire(new URL("../architecture/package.json", import.meta.url))("yaml");
const steps = (
  parse(await readFile(join(repo, ".github/workflows/release.yml"), "utf8")) as {
    jobs: { release: { steps: { name?: string; if?: string; run?: string; env?: object }[] } };
  }
).jobs.release.steps;
const step = (name: string) => {
  const found = steps.find((entry) => entry.name === name);
  assert.ok(found?.run, `missing step ${name}`);
  return found as { if?: string; run: string; env?: Record<string, string> };
};

interface Context {
  readonly env: Record<string, string>;
  readonly steps: Record<string, { outcome: string; outputs?: Record<string, string> }>;
  /** A step before this one failed: a condition without a status function then never runs. */
  readonly failed: boolean;
}
/** A step's `if:` as Actions decides it, for the expressions release.yml's conditions use. */
const holds = (name: string, context: Context) => {
  const expression = step(name).if ?? "";
  const js = expression
    .replace(/\bsteps\.([\w-]+)\.outcome\b/gu, (_, id: string) =>
      JSON.stringify(context.steps[id]?.outcome ?? "skipped"),
    )
    .replace(/\bsteps\.([\w-]+)\.outputs\.([\w-]+)/gu, (_, id: string, output: string) =>
      JSON.stringify(context.steps[id]?.outputs?.[output] ?? ""),
    )
    .replace(/\benv\.(\w+)/gu, (_, variable: string) => JSON.stringify(context.env[variable] ?? ""))
    .replace(/\balways\(\)/gu, "true")
    .replace(/\bsuccess\(\)/gu, String(!context.failed))
    .replace(/\bfailure\(\)/gu, String(context.failed))
    .replace(/\bcancelled\(\)/gu, "false")
    .replaceAll("'", '"');
  assert.match(js, /^(?:[\s().&|!=]|true|false|"[\w-]*")*$/u, `unknown: ${expression}`);
  // Without a status function, Actions runs the step only while nothing before it failed.
  const status = /\b(?:always|success|failure|cancelled)\(\)/u.test(expression);
  return runInNewContext(status ? js : `${!context.failed} && (${js})`) as boolean;
};

const signingKey = "ab".repeat(32);
const device = { computer: "computer-1", grant: "native:grant-1", user: "user-1", pool: "pool-1" };

/** The live pool's wire for the acceptance client; `answer` refuses or fails one call by number. */
async function pool() {
  let chats = 0;
  const state: { answer: Partial<Record<number | "catalog", number>> } = { answer: {} };
  const server = createServer((request, response) => {
    const catalog = request.url === "/v1/models";
    if (!catalog) chats++;
    const status = state.answer[catalog ? "catalog" : chats];
    if (status !== undefined) {
      response.writeHead(status, { "content-type": "application/json" });
      response.end('{"error":"unauthorized","message":"refused"}');
      return;
    }
    response.writeHead(200, {
      "content-type": catalog ? "application/json" : "text/event-stream",
      "x-signalbox-pool-boot": "boot-root",
    });
    response.end(
      catalog
        ? '{"object":"list","data":[{"id":"model-a","object":"model"}]}'
        : 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    answer: (answer: typeof state.answer) => {
      chats = 0;
      state.answer = answer;
    },
    close: () => server.close(),
  };
}

/** Runs a step's script as Actions does (`bash -e`), with `bun` the real entry on a test stage. */
async function runStep(name: string, cwd: string, env: Record<string, string>) {
  const body = step(name)
    .run.replace(/\$\{\{[^}]*\}\}/gu, "any")
    .replaceAll("--stage production", "--stage test-acceptance-workflow");
  // Its own process group, so a hung entry under bash dies with it rather than outliving the test.
  const child = spawn("bash", ["-e", "-c", body], {
    cwd,
    env: { PATH: `${join(cwd, "bin")}:${process.env.PATH ?? ""}`, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const timer = setTimeout(() => process.kill(-child.pid!, "SIGKILL"), 60_000);
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const status = await new Promise<number | null>((done) => child.on("close", done));
  clearTimeout(timer);
  return { status, output };
}

const outputs = async (file: string) =>
  Object.fromEntries(
    (await readFile(file, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("=", 2) as [string, string]),
  );

test("a refusal after this run's admitted boot read rolls back; a cap or a refused boot read never does", async () => {
  // The entry keeps a failed run's private detail in the repo's own .local/release.
  const kept = ["failure", "acceptance"].map((file) => join(repo, `.local/release/${file}.txt`));
  const before = await Promise.all(kept.map((file) => readFile(file, "utf8").catch(() => undefined)));
  const live = await pool();
  const dir = await mkdtemp(
    join(process.env.RUNNER_TEMP ?? join(homedir(), "Library", "Caches"), "release-accept-"),
  );
  try {
    await mkdir(join(dir, "bin"));
    await writeFile(
      join(dir, "bin", "bun"),
      `#!/bin/sh\nentry="$1"; shift\nexec "${process.execPath}" "${repo}$entry" "$@"\n`,
    );
    await writeFile(join(dir, "bin", "node"), "#!/bin/sh\nexit 0\n");
    await chmod(join(dir, "bin", "bun"), 0o755);
    await chmod(join(dir, "bin", "node"), 0o755);
    await writeFile(join(dir, "policy.json"), "{}");
    const env = (output: string) => ({
      POLICY: join(dir, "policy.json"),
      GITHUB_OUTPUT: join(dir, output),
      POOL_ACCEPTANCE_ORIGIN: live.origin,
      POOL_ACCEPTANCE_DEVICE: JSON.stringify(device),
      POOL_APP_SIGNING_KEY: signingKey,
    });
    // This run's boot read, served for the device: the pool admitted it before the apply.
    await writeFile(join(dir, "boot"), "");
    const boot = await runStep("Record the root's boot before the apply", dir, env("boot"));
    assert.equal(boot.status, 0, boot.output);
    const after = async (label: string, answer: Partial<Record<number | "catalog", number>>) => {
      live.answer(answer);
      await writeFile(join(dir, `accept-${label}`), "");
      await rm(join(dir, ".local/release/acceptance.json"), { force: true });
      const accept = await runStep("Accept the release through the live pool", dir, env(`accept-${label}`));
      return { status: accept.status, output: accept.output, outputs: await outputs(join(dir, `accept-${label}`)) };
    };
    const context = (policy: string, accept: Awaited<ReturnType<typeof after>>): Context => ({
      env: { MODE: "apply", POLICY_NAME: policy },
      steps: {
        serving: { outcome: "success" },
        apply: { outcome: "success" },
        accept: { outcome: accept.status === 0 ? "success" : "failure", outputs: accept.outputs },
      },
      // The accept step continues on error, so the steps after it still run.
      failed: false,
    });

    // 401 or 403 after the admitted read: a serving failure, so the code policy rolls it back.
    for (const answer of [{ catalog: 403 }, { 27: 401 }]) {
      const label = JSON.stringify(answer);
      const accept = await after(label.replace(/\W/gu, ""), answer);
      assert.equal(accept.status, 1, `${label}: ${accept.output}`);
      assert.equal(accept.outputs.acceptance, undefined, label);
      assert.equal(holds("Roll back a failed release", context("code", accept)), true, label);
      assert.equal(holds("Stop on an acceptance that could not test", context("code", accept)), false, label);
      // The class change has no rollback: it stops red and says so.
      assert.equal(holds("Roll back a failed release", context("cutover-classes", accept)), false, label);
      assert.equal(holds("Stop on a failed class change", context("cutover-classes", accept)), true, label);
      const stop = await runStep("Stop on a failed class change", dir, {
        APPLY_OUTCOME: "success",
        ACCEPTANCE: accept.outputs.acceptance ?? "",
        SMOKE: accept.outputs.smoke ?? "",
      });
      assert.match(stop.output, /Cause: 1 of (?:1|27) model requests failed$/mu, label);
    }

    // A 429 after the admitted read is its user's cap: nothing was tested, nothing rolls back.
    const capped = await after("capped", { 9: 429 });
    assert.equal(capped.status, 4, capped.output);
    assert.equal(capped.outputs.acceptance, "could-not-test");
    assert.equal(holds("Roll back a failed release", context("code", capped)), false);
    assert.equal(holds("Stop on an acceptance that could not test", context("code", capped)), true);
    const untested = await runStep("Stop on a failed class change", dir, {
      APPLY_OUTCOME: "success",
      ACCEPTANCE: capped.outputs.acceptance ?? "",
      SMOKE: capped.outputs.smoke ?? "",
    });
    assert.match(untested.output, /Cause: the pool refused the acceptance device \(HTTP 429\)/u);

    // A refusal at the boot read itself stops the run before the apply, as built.
    live.answer({ catalog: 401 });
    await writeFile(join(dir, "boot-refused"), "");
    const refused = await runStep("Record the root's boot before the apply", dir, env("boot-refused"));
    assert.equal(refused.status, 4, refused.output);
    const stopped: Context = {
      env: { MODE: "apply", POLICY_NAME: "code" },
      steps: { serving: { outcome: "success" } },
      failed: true,
    };
    assert.equal(holds("Apply the reviewed plan", stopped), false, "nothing is applied");
    assert.equal(holds("Roll back a failed release", stopped), false, "nothing to undo");
  } finally {
    live.close();
    await rm(dir, { recursive: true, force: true });
    for (const [index, file] of kept.entries()) {
      if (before[index] === undefined) await rm(file, { force: true });
      else await writeFile(file, before[index]!);
    }
  }
});

test("a failed class change names its real cause from the fields the acceptance record writes", async () => {
  const name = "Stop on a failed class change";
  // What the step reads comes from the steps before it, not from a record field nobody writes.
  assert.deepEqual(step(name).env, {
    APPLY_OUTCOME: "${{ steps.apply.outcome }}",
    ACCEPTANCE: "${{ steps.accept.outputs.acceptance }}",
    SMOKE: "${{ steps.accept.outputs.smoke }}",
  });
  const run = async (record: object | undefined, env: Record<string, string>) => {
    const dir = await mkdtemp(
      join(process.env.RUNNER_TEMP ?? join(homedir(), "Library", "Caches"), "release-classes-"),
    );
    try {
      await mkdir(join(dir, ".local/release"), { recursive: true });
      if (record)
        await writeFile(join(dir, ".local/release/acceptance.json"), JSON.stringify(record));
      const result = await runStep(name, dir, env);
      assert.equal(result.status, 1, "the run is never green");
      return /Cause: (.*)$/mu.exec(result.output)?.[1] ?? result.output;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  const accepted = { APPLY_OUTCOME: "success", SMOKE: "" };
  assert.match(await run(undefined, { APPLY_OUTCOME: "failure" }), /^the apply failed/u);
  assert.match(
    await run({ passed: false, requests: 27, failed: 3, runtimes: 1 }, accepted),
    /^3 of 27 model requests failed$/u,
  );
  assert.match(
    await run(
      { passed: false, requests: 0, failed: 0, refused: [429], runtimes: 0, outcome: "could-not-test" },
      { ...accepted, ACCEPTANCE: "could-not-test" },
    ),
    /^the pool refused the acceptance device \(HTTP 429\), so nothing was tested$/u,
  );
  assert.match(
    await run({ passed: false, requests: 27, failed: 0, runtimes: 2 }, accepted),
    /^the boot the root had before the apply did not serve after it: the root restarted$/u,
  );
  assert.match(
    await run({ passed: true, requests: 27, failed: 0, runtimes: 1 }, { ...accepted, SMOKE: "1" }),
    /^every model call passed; the public app smoke failed$/u,
  );
  assert.match(
    await run(undefined, { ...accepted, ACCEPTANCE: "could-not-test" }),
    /^the acceptance device was refused or misnamed before any model call/u,
  );
  // A record that says nothing failed never blames the smoke unless the smoke failed.
  assert.doesNotMatch(await run({}, accepted), /smoke/u);
  const unwritten = await run(undefined, accepted);
  assert.match(unwritten, /^acceptance stopped before it wrote a record/u);
  assert.doesNotMatch(unwritten, /apply failed/u, "a successful apply is never named as the cause");
});
