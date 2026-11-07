import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { collectConnectorEvidence } from "./collect-connector-evidence.mjs";
import { connectorDiagnostic } from "./connector-diagnostics.mjs";
import { describeGuidanceFailure } from "../connectors-tests/guidance-failure.ts";

const credential = "private-credential-sentinel";
const tenant = "private-tenant-sentinel";
const layouts = {
  "gitlab-connectors": ["connectors-proof/run-fixture"],
  "slack-health": ["slack-health/ci"],
  "workos-sign-in": ["workos-sign-in/ci"],
  "clerk-sign-in": ["clerk-sign-in/ci"],
  "vercel-sign-in": ["vercel-sign-in/ci"],
  "elevenlabs-sign-in": ["elevenlabs-sign-in/ci"],
  "catalog-compat": ["catalog-compat/ci", "elevenlabs-discovery/ci"],
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "connector-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

test("forced connector failures reach every sibling job's upload without credential or tenant data", async (t) => {
  const { parse } = createRequire(new URL("../architecture/package.json", import.meta.url))("yaml");
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const root = await fixture(t);
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    console.log(JSON.stringify({stage:"gitlab-runtime",checks:7,tenant:"${tenant}"}));
    console.error("AssertionError: ${credential} ${tenant}");
    console.error("CONNECTORS_PROOF_FAILURE phase=gitlab-runtime kind=assertion at=gitlab.mjs:42");
    process.exitCode=1;
  `,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 1);
  for (const [job, sources] of Object.entries(layouts)) {
    const checkout = join(root, job);
    for (const source of sources) {
      const run = join(checkout, ".generated", source);
      if (job === "gitlab-connectors") {
        await put(
          join(run, "runtime.json"),
          JSON.stringify({ code: child.status, stdout: child.stdout, stderr: child.stderr }),
        );
      } else {
        await put(
          join(run, "partial-results.json"),
          JSON.stringify([{ name: tenant, actual: credential, passed: false }]),
        );
      }
      await put(join(run, "failure.txt"), child.stderr);
      await put(join(run, "home/session.json"), JSON.stringify({ credential, tenant }));
      await put(join(run, "screenshot.png"), `${credential} ${tenant}`);
    }
    const steps = workflow.jobs[job].steps;
    const collectIndex = steps.findIndex((step) =>
      step.run?.includes("node scripts/ci/collect-connector-evidence.mjs "),
    );
    assert.ok(collectIndex >= 0, `${job} collects sanitized connector evidence`);
    const uploadIndex = steps.findIndex((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    assert.ok(collectIndex < uploadIndex, job);
    assert.equal(steps[collectIndex].if, "always()", job);
    assert.equal(steps[uploadIndex].if, "always()", job);
    const runnerTemp = join(checkout, "runner-temp");
    const args = steps[collectIndex].run
      .trim()
      .split(/\s+/)
      .slice(2)
      .map((argument) => argument.replace(/^"|"$/g, "").replace("$RUNNER_TEMP", runnerTemp));
    const collector = fileURLToPath(new URL("./collect-connector-evidence.mjs", import.meta.url));
    execFileSync(process.execPath, [collector, ...args], { cwd: checkout, stdio: "pipe" });
    const upload = steps[uploadIndex].with.path.replace("${{ runner.temp }}", runnerTemp).trim();
    assert.equal(upload, args[1], `${job} uploads only the projected JSON file`);
    const text = await readFile(upload, "utf8");
    assert.ok(!text.includes(credential) && !text.includes(tenant), job);
    const result = JSON.parse(text);
    assert.equal(result.job, job);
    assert.equal(result.status, "recorded");
    assert.equal(result.runs.length, sources.length);
    for (const run of result.runs) {
      assert.ok(
        run.records.some((record) => record.outcome === "failed" && record.kind === "assertion"),
      );
      assert.ok(
        run.records.every(
          (record) => !Object.hasOwn(record, "stderr") && !Object.hasOwn(record, "stdout"),
        ),
      );
    }
    if (process.env.BASALT_CONNECTOR_UPLOAD_PROOF_DIR)
      await put(join(process.env.BASALT_CONNECTOR_UPLOAD_PROOF_DIR, `${job}.json`), text);
  }
});

test("unknown phase, kind, source and extra data cannot enter the projected record", () => {
  const output = connectorDiagnostic("runtime", {
    code: 1,
    checks: 4,
    stdout: JSON.stringify({ stage: tenant, checks: credential, arbitrary: tenant }),
    stderr: `CONNECTORS_PROOF_FAILURE phase=${tenant} kind=${credential} at=${tenant}.mjs:42`,
    tenant,
    credential,
  });
  assert.deepEqual(output, {
    stage: "runtime",
    outcome: "failed",
    phase: "unknown",
    kind: "unknown",
    code: 1,
    checks: 4,
  });
});

test("an unconfirmed report stays observed while tenant startup failures retain their phase", () => {
  assert.equal(connectorDiagnostic("report", { checks: [] }).outcome, "observed");
  assert.deepEqual(
    connectorDiagnostic("zendesk-tenant", {
      code: 1,
      stdout: `Zendesk tenant proof: tenant-public-client\n${tenant}`,
      stderr: `TypeError: ${credential}`,
    }),
    {
      stage: "zendesk-tenant",
      outcome: "failed",
      phase: "tenant-public-client",
      kind: "type",
      code: 1,
    },
  );
});

test("collector excludes links, malformed and oversized files without copying their contents", async (t) => {
  const root = await fixture(t),
    run = join(root, ".generated/connectors-proof/run-fixture");
  await put(join(root, "private.json"), JSON.stringify({ code: 1, stderr: credential }));
  await mkdir(run, { recursive: true });
  await symlink(join(root, "private.json"), join(run, "runtime.json"));
  await put(join(run, "install.json"), credential.repeat(100_000));
  await put(join(run, "report.json"), `${tenant}{`);
  const output = await collectConnectorEvidence(root, "gitlab-connectors");
  assert.deepEqual(output.runs[0].records, [
    { stage: "install", input: "too-large" },
    { stage: "runtime", input: "omitted" },
    { stage: "report", input: "malformed" },
  ]);
  assert.ok(
    !JSON.stringify(output).includes(tenant) && !JSON.stringify(output).includes(credential),
  );
});

test("run collection is bounded and missing evidence is explicit", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await collectConnectorEvidence(root, "gitlab-connectors"), {
    version: 1,
    job: "gitlab-connectors",
    truncated: false,
    status: "no-evidence",
    runs: [],
  });
  for (let index = 0; index < 12; index++)
    await put(
      join(root, `.generated/connectors-proof/run-${index}/runtime.json`),
      JSON.stringify({ code: 1, stderr: "AssertionError" }),
    );
  const output = await collectConnectorEvidence(root, "gitlab-connectors");
  assert.equal(output.runs.length, 8);
  assert.equal(output.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(output)) < 64 * 1024);
});

test("guidance launch failures retain their closed class in the collected artifact", async (t) => {
  const root = await fixture(t);
  const run = join(root, ".generated/connectors-proof/run-guidance");
  for (const [detail, marker] of [
    ["Executable doesn't exist", "missing-executable"],
    ["No usable sandbox!", "sandbox"],
    ["error while loading shared libraries: libfixture.so", "missing-library"],
    ["Timeout 30000ms exceeded", "timeout"],
    ["--no-sandbox SingletonSocket path is too long", "other"],
  ]) {
    const error = new Error(`${detail} ${credential} ${tenant} https://private.invalid`);
    error.stack +=
      "\n    at proveCompanyGuidance (/private/scripts/connectors-tests/zendesk-company-guidance.mjs:31:8)";
    const failure = describeGuidanceFailure(error, "company-guidance");
    await put(
      join(run, "zendesk-company-guidance.json"),
      JSON.stringify({
        code: 1,
        stdout: "Zendesk tenant proof: company-guidance",
        stderr: failure.publicLine,
      }),
    );
    await put(join(run, "home/session.json"), JSON.stringify({ credential, tenant }));
    const result = await collectConnectorEvidence(root, "gitlab-connectors");
    assert.deepEqual(result.runs[0].records, [
      {
        stage: "company-guidance",
        outcome: "failed",
        phase: "company-guidance",
        kind:
          marker === "timeout"
            ? "timeout"
            : marker === "missing-executable"
              ? "browser-launch"
              : "runtime",
        errorName: "Error",
        marker,
        code: 1,
        location: "zendesk-company-guidance.mjs:31",
      },
    ]);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(credential) && !serialized.includes(tenant));
    assert.ok(!serialized.includes("https://") && !serialized.includes("/private/"));
  }
});

test("unknown error names and markers cannot enter connector artifacts", () => {
  for (const suffix of [
    `error=${tenant} marker=other`,
    `error=Error marker=${credential}`,
    `error=Error marker=other https://private.invalid`,
  ]) {
    const result = connectorDiagnostic("company-guidance", {
      code: 1,
      stderr: `CONNECTORS_PROOF_FAILURE phase=company-guidance kind=browser-launch at=zendesk-company-guidance.mjs:31 ${suffix}`,
    });
    assert.equal(result.errorName, undefined);
    assert.equal(result.marker, undefined);
    assert.ok(
      !JSON.stringify(result).includes(tenant) && !JSON.stringify(result).includes(credential),
    );
  }
  const error = new Error(`${credential} ${tenant}`);
  error.name = tenant;
  const failure = describeGuidanceFailure(error, tenant);
  assert.match(failure.publicLine, /phase=initialization .* error=UnknownError marker=other$/);
  assert.ok(!failure.publicLine.includes(tenant) && !failure.publicLine.includes(credential));
});
