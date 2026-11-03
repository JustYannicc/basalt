import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, hash } from "./production-ops/artifact.ts";
import { productionOperation, type OpsInput } from "./production-ops/client.ts";
import { openEnvelope } from "../src/pool/token.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationFailure } from "./production-ops/failure.ts";

const target = "https://operator.example.test";
const signingKey = "ab".repeat(32);
const request: OpsInput = {
  target,
  signingKey,
  action: "migrate",
  mode: "apply",
  selection: "migration-v1",
  request: '{"organization":"org_proof","accounts":["acc_proof"]}',
  recipient: "YQ==",
  planSha256: "1".repeat(64),
  go: `GO ${"1".repeat(64)}`,
};
const backup = { version: 1, sealed: { ciphertext: "encrypted" } };
const previous = {
  action: "dry-run",
  artifact: { sha256: request.planSha256 },
  backup,
  backupSha256: hash(`${canonical(backup)}\n`),
};

test("an apply requires the exact saved dry-run and uploaded backup before sending a signed request", async () => {
  let calls = 0;
  const send: typeof fetch = async (_url, init) => {
    calls++;
    const parsed: unknown = JSON.parse(String(init?.body));
    assert.ok(
      typeof parsed === "object" &&
        parsed !== null &&
        "envelope" in parsed &&
        typeof parsed.envelope === "string",
    );
    const signed = await openEnvelope(signingKey, "sbops1", parsed.envelope);
    assert.ok(
      typeof signed === "object" && signed !== null && "target" in signed && "operation" in signed,
    );
    assert.equal(signed.target, target);
    assert.deepEqual(signed.operation, {
      action: "apply",
      selection: "migration-v1",
      request: { organization: "org_proof", accounts: ["acc_proof"] },
      recipient: "YQ==",
      artifact: previous.artifact,
      planSha256: request.planSha256,
      backupSha256: previous.backupSha256,
      go: request.go,
    });
    return Response.json({
      action: "apply",
      planSha256: request.planSha256,
      verification: { ok: true },
    });
  };
  for (const invalid of [
    request,
    { ...request, previous, request: "{}" },
    { ...request, previous, request: '{"organization":""}' },
    { ...request, previous, go: "GO another-plan" },
    { ...request, previous: { ...previous, artifact: { sha256: "2".repeat(64) } } },
    { ...request, previous: { ...previous, backup: { changed: true } } },
    { ...request, previous: { ...previous, action: "apply" } },
  ])
    await assert.rejects(productionOperation(invalid, send));
  assert.equal(calls, 0);
  assert.equal((await productionOperation({ ...request, previous }, send)).action, "apply");
  assert.equal(calls, 1);
});

test("a refused response never exposes its private body or repeats the mutation", async () => {
  let calls = 0;
  const send: typeof fetch = async () => {
    calls++;
    return new Response("private-provider-token", { status: 409 });
  };
  await assert.rejects(
    productionOperation({ ...request, previous }, send),
    (error: unknown) =>
      error instanceof OperationFailure &&
      error.message === "Production operation failed" &&
      error.receipt.category === "unknown" &&
      error.receipt.phase === "request" &&
      error.receipt.httpStatus === 409,
  );
  assert.equal(calls, 1);
});

const poison = "DO-NOT-RETAIN-password-response-credential";

test("the operator CLI retains classified composite, defect and migration refusals safely", () => {
  for (const [category, causeKind, sqlStateClass] of [
    ["refused", "failure", undefined],
    ["defect", "defect", undefined],
    ["sql", "composite", "22"],
  ] as const) {
    const receipt = {
      format: "basalt-production-ops-failure-v1",
      category,
      phase: "sql",
      causeKind,
      ...(sqlStateClass === undefined ? {} : { sqlStateClass }),
    };
    const { directory, result } = run({
      error: "operation_refused",
      failure: { ...receipt, message: poison, cause: { password: poison } },
    });
    try {
      assert.equal(result.status, 1);
      const text = readFileSync(join(directory, "failure.json"), "utf8");
      assert.deepEqual(JSON.parse(text), { ...receipt, httpStatus: 409 });
      assert.ok(!`${text}${result.stdout}${result.stderr}`.includes(poison));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function run(response?: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "production-ops-failure-"));
  const fixture = join(directory, "fetch.mjs");
  writeFileSync(
    fixture,
    `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(response))}, {status: 409});`,
  );
  const result = spawnSync(
    process.execPath,
    ["--import", fixture, "scripts/production-ops/run.ts"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REF: "refs/heads/main",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        POOL_APP_SIGNING_KEY: response === undefined ? poison : "ab".repeat(32),
        OPS_ACTION: "inventory",
        OPS_SELECTION: "organizations",
        OPS_REQUEST: '{"organization":"synthetic-organization"}',
        OPS_RECIPIENT: "c3ludGhldGlj",
        OPS_OUTPUT_DIRECTORY: directory,
        GITHUB_STEP_SUMMARY: join(directory, "step-summary"),
      },
    },
  );
  return { directory, result };
}

test("the operator CLI requires a fresh dry run for a stale plan", () => {
  const { directory, result } = run({
    error: "operation_refused",
    failure: {
      format: "basalt-production-ops-failure-v1",
      category: "refused",
      phase: "sql",
      causeKind: "failure",
      reason: "stale_plan",
      message: poison,
    },
  });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /run a fresh dry run/);
    const text = readFileSync(join(directory, "failure.json"), "utf8");
    assert.deepEqual(JSON.parse(text), {
      format: "basalt-production-ops-failure-v1",
      category: "refused",
      phase: "sql",
      causeKind: "failure",
      reason: "stale_plan",
      httpStatus: 409,
    });
    assert.ok(!`${text}${result.stdout}${result.stderr}`.includes(poison));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed operator CLI saves a safe receipt before exiting", () => {
  const { directory, result } = run();
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Production operation failed/);
    const text = readFileSync(join(directory, "failure.json"), "utf8");
    assert.deepEqual(JSON.parse(text), {
      format: "basalt-production-ops-failure-v1",
      category: "config",
      phase: "config",
    });
    assert.ok(!`${text}${result.stdout}${result.stderr}`.includes(poison));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime refusals retain only allowlisted diagnostic fields", () => {
  const { directory, result } = run({
    error: poison,
    failure: {
      format: "basalt-production-ops-failure-v1",
      category: "sql",
      phase: "sql",
      sqlStateClass: "42",
      message: poison,
      credentials: poison,
    },
  });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Production operation failed/);
    const text = readFileSync(join(directory, "failure.json"), "utf8");
    assert.deepEqual(JSON.parse(text), {
      format: "basalt-production-ops-failure-v1",
      category: "sql",
      phase: "sql",
      sqlStateClass: "42",
      httpStatus: 409,
    });
    assert.ok(!`${text}${result.stdout}${result.stderr}`.includes(poison));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a busy runtime 409 keeps its safe reason and retryability in failure.json", () => {
  const busy = {
    error: "operation_busy",
    retryable: true,
    failure: {
      format: "basalt-production-ops-failure-v1",
      category: "sql",
      phase: "sql",
      sqlStateClass: "55",
      message: poison,
    },
  };
  const response = process.env.BASALT_OPS_BUSY_RESPONSE
    ? JSON.parse(readFileSync(process.env.BASALT_OPS_BUSY_RESPONSE, "utf8"))
    : busy;
  const { directory, result } = run(response);
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Production operation is busy/);
    const text = readFileSync(join(directory, "failure.json"), "utf8");
    assert.deepEqual(JSON.parse(text), {
      format: "basalt-production-ops-failure-v1",
      category: "sql",
      phase: "sql",
      sqlStateClass: "55",
      reason: "operation_busy",
      retryable: true,
      httpStatus: 409,
    });
    assert.ok(!`${text}${result.stdout}${result.stderr}`.includes(poison));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("organization removal remains a non-retryable safe refusal in failure.json", () => {
  const { directory, result } = run({
    error: "organization_removing",
    retryable: false,
    failure: { format: "basalt-production-ops-failure-v1", category: "auth", phase: "sql" },
  });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /organization_removing/);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "failure.json"), "utf8")), {
      format: "basalt-production-ops-failure-v1",
      category: "auth",
      phase: "sql",
      reason: "organization_removing",
      retryable: false,
      httpStatus: 409,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
