import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { brand } from "../../brand.ts";
import { openEnvelope } from "../../src/pool/token.ts";
import { receiptIdSha256 } from "./artifact.ts";
import { createHash } from "node:crypto";
import {
  acceptanceOperation,
  AcceptanceRefusal,
  upstreamOriginSha256,
  type AcceptanceInput,
} from "./client.ts";

const signingKey = "ab".repeat(32);
const origin = "https://upstream.example.test";
const key = "poison-upstream-key-".padEnd(40, "z");
const planSha256 = "1".repeat(64);
const previous = {
  action: "dry-run",
  kind: "setup",
  planSha256,
  artifact: { sha256: planSha256 },
};
const reason = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof AcceptanceRefusal, String(error));
    return error.failure.reason;
  }
  assert.fail("expected a refusal");
};

type Answer = (signed: Record<string, unknown>) => { status: number; body: unknown };
const answered: Answer = (signed) => {
  const operation = signed.operation as { action: string; kind: string };
  return { status: 200, body: { action: operation.action, kind: operation.kind, planSha256 } };
};

/**
 * A real local server where the tools service stands: the driver's own fetch reaches it, and it
 * records each signed request it opens before it answers.
 */
async function toolsService(t: TestContext, answer: Answer = answered) {
  const sent: Record<string, unknown>[] = [];
  const paths: string[] = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    paths.push(request.url ?? "");
    const body = JSON.parse(text) as { envelope: string };
    const signed = (await openEnvelope(signingKey, "sbacc1", body.envelope)) as Record<
      string,
      unknown
    >;
    sent.push(signed);
    const out = answer(signed);
    response.writeHead(out.status, { "content-type": "application/json" });
    response.end(JSON.stringify(out.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  const target = `http://127.0.0.1:${port}`;
  const setup: AcceptanceInput = {
    target,
    signingKey,
    kind: "setup",
    action: "dry-run",
    request: JSON.stringify({ pool: "acceptance-run-1", accounts: [] }),
    recipient: "YQ==",
    planSha256: "",
    go: "",
    upstreamOrigin: origin,
  };
  return { target, setup, sent, paths };
}

// The server computes the same digest; scripts/upstream-tests/acceptance-pool-runner.test.ts
// compares the two functions directly.
const serverDigest = (value: string) =>
  createHash("sha256").update(`basalt-acceptance-upstream-origin-v1\n${value}`).digest("hex");

test("the driver sends only the digest of the origin, never the address", async (t) => {
  assert.equal(upstreamOriginSha256(origin), serverDigest(origin));
  assert.equal(
    upstreamOriginSha256(`${origin}/`),
    serverDigest(origin),
    "a trailing slash names the same origin",
  );
  const tools = await toolsService(t);
  await acceptanceOperation(tools.setup);
  assert.deepEqual(tools.paths, ["/api/internal/acceptance-pool"]);
  const [signed] = tools.sent;
  assert.ok(signed);
  assert.equal(signed.target, tools.target);
  assert.equal(Number(signed.expiresAt) - Number(signed.at), 60_000);
  const operation = signed.operation as Record<string, unknown>;
  assert.equal(operation.upstreamOriginSha256, serverDigest(origin));
  assert.ok(!JSON.stringify(signed).includes("upstream.example.test"), "the address is never sent");
  assert.equal(operation.upstreamKey, undefined, "a dry run carries no key");
});

test("only an https target, or plain http to the loopback address, is ever called", async () => {
  const setup: AcceptanceInput = {
    target: "",
    signingKey,
    kind: "setup",
    action: "dry-run",
    request: "{}",
    recipient: "YQ==",
    planSha256: "",
    go: "",
    upstreamOrigin: origin,
  };
  for (const target of [
    "http://operator.example.test",
    "http://localhost:1",
    "https://x.example.test/a",
  ])
    assert.equal(await reason(acceptanceOperation({ ...setup, target })), "config", target);
});

test("an origin with a path, query or credentials, or none at all, is refused before anything is sent", async (t) => {
  const tools = await toolsService(t);
  for (const upstreamOrigin of [
    `${origin}/a`,
    `${origin}?x=1`,
    "https://user@upstream.example.test",
    "http://upstream.example.test",
    "not a url",
  ])
    assert.equal(
      await reason(acceptanceOperation({ ...tools.setup, upstreamOrigin })),
      "upstream_origin_invalid",
    );
  const { upstreamOrigin: _, ...none } = tools.setup;
  assert.equal(await reason(acceptanceOperation(none)), "upstream_origin_missing");
  assert.equal(tools.sent.length, 0);
});

test("an apply needs the saved dry run of the same kind, its checksum and the exact GO, and only a setup apply carries the key", async (t) => {
  const tools = await toolsService(t);
  const apply: AcceptanceInput = {
    ...tools.setup,
    action: "apply",
    planSha256,
    go: `GO ${planSha256}`,
    upstreamKey: key,
    previous,
  };
  for (const invalid of [
    { ...apply, previous: undefined },
    { ...apply, previous: { ...previous, kind: "teardown" } },
    { ...apply, previous: { ...previous, action: "apply" } },
    { ...apply, previous: { ...previous, artifact: { sha256: "2".repeat(64) } } },
    { ...apply, go: `GO ${"2".repeat(64)}` },
    { ...apply, go: planSha256 },
  ])
    assert.equal(await reason(acceptanceOperation(invalid)), "config");
  const { upstreamKey: _, ...keyless } = apply;
  assert.equal(await reason(acceptanceOperation(keyless)), "upstream_key_missing");
  assert.equal(tools.sent.length, 0);
  await acceptanceOperation(apply);
  const [first] = tools.sent;
  assert.ok(first);
  const operation = first.operation as Record<string, unknown>;
  assert.equal(operation.upstreamKey, key);
  assert.equal(operation.go, `GO ${planSha256}`);
  await acceptanceOperation({
    ...apply,
    kind: "teardown",
    request: JSON.stringify({ setup: planSha256 }),
    previous: { ...previous, kind: "teardown" },
  });
  const [, teardown] = tools.sent;
  assert.ok(teardown);
  assert.equal((teardown.operation as Record<string, unknown>).upstreamKey, undefined);
});

test("a refusal reports only the server's closed word", async (t) => {
  let next: unknown = {};
  const tools = await toolsService(t, () => ({ status: 409, body: next }));
  next = { reason: "operation_busy", step: "x" };
  assert.equal(await reason(acceptanceOperation(tools.setup)), "operation_busy");
  next = { reason: `leaked ${key}` };
  assert.equal(await reason(acceptanceOperation(tools.setup)), "unknown");
  next = { reason: "step_failed", step: `bad step ${key}` };
  try {
    await acceptanceOperation(tools.setup);
    assert.fail("expected a refusal");
  } catch (error) {
    assert.ok(error instanceof AcceptanceRefusal);
    assert.equal(error.failure.step, undefined, "a step name outside the closed shape is dropped");
    assert.equal(error.failure.httpStatus, 409);
  }
});

const run = (env: Record<string, string>, response: unknown, status = 200) => {
  const directory = mkdtempSync(join(tmpdir(), "acceptance-pool-run-"));
  const fixture = join(directory, "fetch.mjs");
  writeFileSync(
    fixture,
    `import { appendFileSync } from "node:fs"; globalThis.fetch = async () => { appendFileSync(${JSON.stringify(join(directory, "fetched"))}, "x"); return new Response(${JSON.stringify(JSON.stringify(response))}, {status: ${status}}); };`,
  );
  const result = spawnSync(
    process.execPath,
    ["--import", fixture, "scripts/acceptance-pool/run.ts"],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        GITHUB_REF: "refs/heads/main",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        POOL_APP_SIGNING_KEY: signingKey,
        ACCEPTANCE_TARGET: "production",
        ACCEPTANCE_KIND: "setup",
        ACCEPTANCE_ACTION: "dry-run",
        ACCEPTANCE_REQUEST: JSON.stringify({ pool: "acceptance-run-1", accounts: [] }),
        ACCEPTANCE_RECIPIENT: "YQ==",
        EMULATED_UPSTREAM_ORIGIN: origin,
        EMULATED_UPSTREAM_KEY: key,
        ACCEPTANCE_OUTPUT_DIRECTORY: join(directory, "out"),
        GITHUB_STEP_SUMMARY: join(directory, "step-summary"),
        ...env,
      },
    },
  );
  const byName: Record<string, string> = (() => {
    try {
      return Object.fromEntries(
        readdirSync(join(directory, "out")).map((name) => [
          name,
          readFileSync(join(directory, "out", name), "utf8"),
        ]),
      );
    } catch {
      return {};
    }
  })();
  const files = Object.values(byName);
  let summary = "";
  try {
    summary = readFileSync(join(directory, "step-summary"), "utf8");
  } catch {}
  let fetched = 0;
  try {
    fetched = readFileSync(join(directory, "fetched"), "utf8").length;
  } catch {}
  rmSync(directory, { recursive: true, force: true });
  return {
    result,
    files,
    byName,
    summary,
    fetched,
    everything: [...files, summary, result.stdout, result.stderr].join("\n"),
  };
};

test("no file, summary or log line the driver writes holds the key or the origin", () => {
  const planned = run(
    {},
    {
      action: "dry-run",
      kind: "setup",
      planSha256,
      artifact: { sha256: planSha256 },
      steps: 5,
      writes: 9,
      upstreamConfigured: "yes",
    },
  );
  assert.equal(planned.result.status, 0, planned.result.stderr);
  assert.match(planned.summary, /upstream host configured: yes/u);
  const refused = run(
    {},
    { error: "acceptance_pool_refused", reason: "upstream_differs", retryable: false },
    409,
  );
  assert.equal(refused.result.status, 1);
  assert.match(refused.result.stderr, /refused: upstream_differs/u);
  for (const outcome of [planned, refused]) {
    assert.ok(outcome.files.length > 0);
    assert.ok(!outcome.everything.includes(key), "the key appears nowhere");
    assert.ok(!outcome.everything.includes("upstream.example.test"), "the origin appears nowhere");
  }
});

test("the driver refuses any ref but main and any target but production, before sending", () => {
  const offMain = run({ GITHUB_REF: "refs/heads/feature" }, {});
  assert.equal(offMain.result.status, 1);
  assert.equal(offMain.fetched, 0, "nothing is sent from another ref");
  for (const stage of ["https://evil.example.test", "test-rehearsal-1", "test-pr-1", ""]) {
    const refused = run({ ACCEPTANCE_TARGET: stage }, {});
    assert.equal(refused.result.status, 1, stage);
    assert.match(refused.result.stderr, /target_invalid/u);
  }
});

test("the production target's host comes from the brand", async () => {
  const { targetOf } = await import("./target.ts");
  assert.equal(targetOf("production").origin, `https://${brand.host}`);
  assert.throws(() => targetOf("test-rehearsal-3"), AcceptanceRefusal);
});

test("no file or line a run keeps names the pool app, its accounts, the host or an address, for any action", () => {
  const app = "app_synthetic_pool";
  const accounts = ["acc_synthetic_a", "acc_synthetic_b"];
  const host = "upstream.example.test";
  const email = "acceptance@basalt.invalid";
  // Ids in places the driver does not name, too: a run keeps the fields it names, in their shapes.
  const stray = { pool: app, upstream: host, owner: email };
  const receipt = {
    migration: "acceptance-pool-setup-v1",
    organization: "acceptance",
    status: "applied",
    app,
    accounts,
    ...stray,
  };
  const verification = { ok: true, checks: { onePool: true, [app]: true }, ...stray };
  const answer = (action: string, kind: string) => ({
    action,
    kind,
    planSha256,
    completed: true,
    receipt,
    verification,
    ...stray,
  });
  const sealed = {
    version: 1,
    sha256: planSha256,
    sealed: "c2VhbGVk",
    recipient: "a2V5",
    ...stray,
  };
  const sourceRun = {
    path: ".github/workflows/acceptance-pool.yml",
    head_branch: "main",
    event: "workflow_dispatch",
    conclusion: "success",
  };
  /** A dry run, then the apply that runs from the dry run's kept file, as the workflow downloads it. */
  const planAndApply = (kind: string, request: string) => {
    const planned = run(
      { ACCEPTANCE_KIND: kind, ACCEPTANCE_REQUEST: request },
      {
        action: "dry-run",
        kind,
        planSha256,
        artifact: sealed,
        steps: 7,
        writes: 9,
        ...(kind === "setup" ? { upstreamConfigured: "yes" } : {}),
        ...stray,
      },
    );
    assert.equal(planned.result.status, 0, planned.result.stderr);
    assert.deepEqual(JSON.parse(planned.byName["operation.json"]!).artifact, {
      version: 1,
      sha256: planSha256,
      sealed: "c2VhbGVk",
      recipient: "a2V5",
    });
    const previous = mkdtempSync(join(tmpdir(), "acceptance-pool-previous-"));
    writeFileSync(join(previous, "operation.json"), planned.byName["operation.json"]!);
    const applied = run(
      {
        ACCEPTANCE_KIND: kind,
        ACCEPTANCE_REQUEST: request,
        ACCEPTANCE_ACTION: "apply",
        ACCEPTANCE_SOURCE_RUN: "42",
        ACCEPTANCE_PLAN_SHA256: planSha256,
        ACCEPTANCE_GO: `GO ${planSha256}`,
        ACCEPTANCE_PREVIOUS_DIRECTORY: previous,
        GITHUB_TOKEN: "fixture-token",
        GITHUB_REPOSITORY: "owner/repository",
      },
      // The same answer stands in for the source run's record the driver reads first.
      { ...answer("apply", kind), ...sourceRun },
    );
    rmSync(previous, { recursive: true, force: true });
    assert.equal(applied.result.status, 0, applied.result.stderr);
    return [planned, applied];
  };
  const [planned, applied] = planAndApply(
    "setup",
    JSON.stringify({ pool: "acceptance-run-1", accounts: [] }),
  );
  const [unplanned, removed] = planAndApply("teardown", JSON.stringify({ setup: planSha256 }));
  const verified = run(
    { ACCEPTANCE_ACTION: "verify", ACCEPTANCE_PLAN_SHA256: planSha256 },
    answer("verify", "setup"),
  );
  const gone = run(
    {
      ACCEPTANCE_KIND: "teardown",
      ACCEPTANCE_ACTION: "verify",
      ACCEPTANCE_PLAN_SHA256: planSha256,
    },
    answer("verify", "teardown"),
  );
  const refused = run(
    { ACCEPTANCE_ACTION: "verify", ACCEPTANCE_PLAN_SHA256: planSha256 },
    { error: "acceptance_pool_refused", reason: "setup_missing", retryable: false, ...stray },
    409,
  );
  assert.equal(refused.result.status, 1);
  assert.ok("failure.json" in refused.byName);
  for (const outcome of [planned!, applied!, unplanned!, removed!, verified, gone, refused]) {
    assert.ok(outcome.files.length > 0);
    // Every kept file, the step summary, and what the run printed.
    for (const forbidden of ["app_", ...accounts, host, email, "@"])
      assert.ok(!outcome.everything.includes(forbidden), `${forbidden} in ${outcome.everything}`);
  }
  for (const outcome of [applied!, removed!, verified, gone]) {
    const kept = JSON.parse(outcome.byName["operation.json"]!);
    assert.deepEqual(kept.receipt, {
      migration: "acceptance-pool-setup-v1",
      organization: "acceptance",
      status: "applied",
      appSha256: receiptIdSha256("app", app),
      accountsSha256: accounts.map((id) => receiptIdSha256("account", id)),
    });
    assert.deepEqual(kept.verification, { ok: true, checks: { onePool: true } });
    assert.match(outcome.summary, /"status": "applied"/u);
    assert.match(outcome.summary, /"accounts": 2/u);
  }
  // The digest is domain-separated: no other kind of id or plain sha256 of the id matches it.
  assert.notEqual(receiptIdSha256("app", app), receiptIdSha256("account", app));
  assert.notEqual(receiptIdSha256("app", app), createHash("sha256").update(app).digest("hex"));
});
