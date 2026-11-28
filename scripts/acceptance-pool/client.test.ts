import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { brand } from "../../brand.ts";
import { openEnvelope } from "../../src/pool/token.ts";
import { createHash } from "node:crypto";
import {
  acceptanceOperation,
  AcceptanceRefusal,
  upstreamOriginSha256,
  type AcceptanceInput,
} from "./client.ts";

const signingKey = "ab".repeat(32);
const target = "https://operator.example.test";
const origin = "https://upstream.example.test";
const key = "poison-upstream-key-".padEnd(40, "z");
const planSha256 = "1".repeat(64);
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

const capture = () => {
  const sent: Record<string, unknown>[] = [];
  const send: typeof fetch = async (url, init) => {
    assert.equal(String(url), `${target}/api/internal/acceptance-pool`);
    const body: unknown = JSON.parse(String(init?.body));
    assert.ok(typeof body === "object" && body !== null && "envelope" in body);
    const signed = await openEnvelope(signingKey, "sbacc1", String(body.envelope));
    assert.ok(typeof signed === "object" && signed !== null);
    sent.push(signed as Record<string, unknown>);
    const operation = (signed as { operation: { action: string; kind: string } }).operation;
    return Response.json({ action: operation.action, kind: operation.kind, planSha256 });
  };
  return { sent, send };
};

// The server computes the same digest; scripts/upstream-tests/acceptance-pool-runner.test.ts
// compares the two functions directly.
const serverDigest = (value: string) =>
  createHash("sha256").update(`basalt-acceptance-upstream-origin-v1\n${value}`).digest("hex");

test("the driver sends only the digest of the origin, never the address", async () => {
  assert.equal(upstreamOriginSha256(origin), serverDigest(origin));
  assert.equal(
    upstreamOriginSha256(`${origin}/`),
    serverDigest(origin),
    "a trailing slash names the same origin",
  );
  const { sent, send } = capture();
  await acceptanceOperation(setup, send);
  const [signed] = sent;
  assert.ok(signed);
  assert.equal(signed.target, target);
  assert.equal(Number(signed.expiresAt) - Number(signed.at), 60_000);
  const operation = signed.operation as Record<string, unknown>;
  assert.equal(operation.upstreamOriginSha256, serverDigest(origin));
  assert.ok(!JSON.stringify(signed).includes("upstream.example.test"), "the address is never sent");
  assert.equal(operation.upstreamKey, undefined, "a dry run carries no key");
});

test("an origin with a path, query or credentials, or none at all, is refused before anything is sent", async () => {
  const { sent, send } = capture();
  for (const upstreamOrigin of [
    `${origin}/a`,
    `${origin}?x=1`,
    "https://user@upstream.example.test",
    "http://upstream.example.test",
    "not a url",
  ])
    assert.equal(
      await reason(acceptanceOperation({ ...setup, upstreamOrigin }, send)),
      "upstream_origin_invalid",
    );
  const { upstreamOrigin: _, ...none } = setup;
  assert.equal(await reason(acceptanceOperation(none, send)), "upstream_origin_missing");
  assert.equal(sent.length, 0);
});

test("an apply needs the saved dry run of the same kind, its checksum and the exact GO, and only a setup apply carries the key", async () => {
  const { sent, send } = capture();
  const apply: AcceptanceInput = {
    ...setup,
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
    assert.equal(await reason(acceptanceOperation(invalid, send)), "config");
  const { upstreamKey: _, ...keyless } = apply;
  assert.equal(await reason(acceptanceOperation(keyless, send)), "upstream_key_missing");
  assert.equal(sent.length, 0);
  await acceptanceOperation(apply, send);
  const [first] = sent;
  assert.ok(first);
  const operation = first.operation as Record<string, unknown>;
  assert.equal(operation.upstreamKey, key);
  assert.equal(operation.go, `GO ${planSha256}`);
  await acceptanceOperation(
    {
      ...apply,
      kind: "teardown",
      request: JSON.stringify({ setup: planSha256 }),
      previous: { ...previous, kind: "teardown" },
    },
    send,
  );
  const [, teardown] = sent;
  assert.ok(teardown);
  assert.equal((teardown.operation as Record<string, unknown>).upstreamKey, undefined);
});

test("a refusal reports only the server's closed word", async () => {
  const answer =
    (body: unknown, status = 409) =>
    async () =>
      new Response(JSON.stringify(body), { status });
  assert.equal(
    await reason(acceptanceOperation(setup, answer({ reason: "operation_busy", step: "x" }))),
    "operation_busy",
  );
  assert.equal(
    await reason(acceptanceOperation(setup, answer({ reason: `leaked ${key}` }))),
    "unknown",
  );
  try {
    await acceptanceOperation(setup, answer({ reason: "step_failed", step: `bad step ${key}` }));
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
    `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(response))}, {status: ${status}});`,
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
        ACCEPTANCE_REQUEST: setup.request,
        ACCEPTANCE_RECIPIENT: "YQ==",
        EMULATED_UPSTREAM_ORIGIN: origin,
        EMULATED_UPSTREAM_KEY: key,
        ACCEPTANCE_OUTPUT_DIRECTORY: join(directory, "out"),
        GITHUB_STEP_SUMMARY: join(directory, "step-summary"),
        ...env,
      },
    },
  );
  const files = (() => {
    try {
      return readdirSync(join(directory, "out")).map((name) =>
        readFileSync(join(directory, "out", name), "utf8"),
      );
    } catch {
      return [];
    }
  })();
  let summary = "";
  try {
    summary = readFileSync(join(directory, "step-summary"), "utf8");
  } catch {}
  rmSync(directory, { recursive: true, force: true });
  return {
    result,
    files,
    summary,
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

test("the driver refuses any ref but main and any target but production or a rehearsal stage, before sending", () => {
  const offMain = run({ GITHUB_REF: "refs/heads/feature" }, {});
  assert.equal(offMain.result.status, 1);
  for (const stage of ["https://evil.example.test", "test-pr-1", "staging", ""]) {
    const refused = run({ ACCEPTANCE_TARGET: stage }, {});
    assert.equal(refused.result.status, 1, stage);
    assert.match(refused.result.stderr, /target_invalid/u);
  }
});

test("a rehearsal stage's host comes from the stage rule", async () => {
  process.env.REHEARSAL_POOL_APP_SIGNING_KEY = "cd".repeat(32);
  try {
    const { targetOf } = await import("./target.ts");
    assert.deepEqual(targetOf("test-rehearsal-3"), {
      origin: `https://app.rehearsal-3.${brand.zone}`,
      signingKey: "cd".repeat(32),
    });
    assert.equal(targetOf("production").origin, `https://${brand.host}`);
  } finally {
    delete process.env.REHEARSAL_POOL_APP_SIGNING_KEY;
  }
});
