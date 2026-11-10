import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudflareArtifactsApi } from "../ensure-artifacts.ts";
import { admitSourceNamespace } from "./commands.ts";
import { releaseEvidence } from "./evidence.ts";

const props = {
  command: "node ensure-artifacts.ts",
  env: {
    CLOUDFLARE_ACCOUNT_ID: "fixture-account",
    CLOUDFLARE_API_TOKEN: "private-fixture-token",
    CLOUD_SOURCE_NAMESPACE: "fixture-apps",
  },
};
const ray = (attempt: number) => `${String(attempt).padStart(16, "0")}-SJC`;
const denied = (attempt: number, status = 403, codes = [10004]) =>
  Response.json(
    { success: false, errors: codes.map((code) => ({ code, message: "private provider text" })) },
    { status, headers: { "cf-ray": ray(attempt), "x-private": "private-header" } },
  );
const readable = () =>
  Response.json(
    {
      success: true,
      result: ["fixture-apps", "fixture-vaults"].map((namespace) => ({
        namespace,
        jurisdiction: "eu",
      })),
    },
    { headers: { "cf-ray": "aaaaaaaaaaaaaaaa-ORD" } },
  );
const provider = (responses: Array<() => Response>) => {
  const calls: string[] = [];
  return {
    calls,
    api: (account: string, token: string) =>
      cloudflareArtifactsApi(account, token, async (url, init) => {
        assert.equal(init?.method, "GET");
        assert.ok(init?.signal instanceof AbortSignal);
        assert.equal(init.signal.aborted, false);
        assert.match(String(url), /\/artifacts\/namespaces\?limit=200$/);
        calls.push(String(url));
        const next = responses.shift();
        assert.ok(next, "unexpected request");
        return next();
      }),
  };
};

test("namespace admission recovers on attempt two and retains safe failed and successful rays", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "namespace-retry-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = releaseEvidence(directory, "a".repeat(40));
  const http = provider([() => denied(1), readable, readable]);
  const waits: number[] = [];
  await admitSourceNamespace(props, http.api, {
    record: evidence.namespaceRead,
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  const receipt = JSON.parse(await readFile(join(directory, "namespace-reads.json"), "utf8"));
  assert.deepEqual(waits, [1000]);
  assert.equal(http.calls.length, 3);
  assert.deepEqual(
    receipt.reads.map(({ attempt, status }: { attempt: number; status: number }) => [
      attempt,
      status,
    ]),
    [
      [1, 403],
      [2, 200],
      [1, 200],
    ],
  );
  assert.equal(receipt.reads[0].ray, ray(1));
  assert.equal(receipt.reads[1].ray, "aaaaaaaaaaaaaaaa-ORD");
  assert.doesNotMatch(
    JSON.stringify(receipt),
    /private|fixture-account|fixture-apps|Authorization/,
  );
  await evidence.record({
    schemaVersion: 1,
    candidate: "a".repeat(40),
    manifest: "b".repeat(64),
    ceilingMs: 750,
    phase: "complete",
    accepted: [],
    activated: [],
  });
  const complete = JSON.parse(await readFile(join(directory, "receipt.json"), "utf8"));
  assert.deepEqual(complete.namespaceReads, receipt.reads);
});

test("exhausted namespace admission refuses before activation with every attempt in the failure receipt", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "namespace-exhausted-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = releaseEvidence(directory, "a".repeat(40));
  const http = provider([() => denied(1), () => denied(2), () => denied(3)]);
  const waits: number[] = [];
  const refusal = await admitSourceNamespace(props, http.api, {
    record: evidence.namespaceRead,
    wait: async (ms) => {
      waits.push(ms);
    },
  }).then(
    () => assert.fail("expected refusal"),
    (error: unknown) => error,
  );
  const receipt = await evidence.failure(refusal);
  assert.equal(receipt.reason, "source-namespace-not-ready");
  assert.deepEqual(receipt.activated, []);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(http.calls.length, 3);
  assert.deepEqual(
    receipt.namespaceReads?.map((read) => [read.attempt, read.status, read.codes, read.ray]),
    [1, 2, 3].map((attempt) => [attempt, 403, [10004], ray(attempt)]),
  );
  assert.doesNotMatch(
    JSON.stringify(receipt),
    /private-fixture-token|private provider text|private-header/,
  );
});

for (const [status, codes] of [
  [403, [10000]],
  [401, [10004]],
  [429, [10004]],
  [503, [10004]],
  [403, [10004, 10000]],
  [403, []],
] as const)
  test(`namespace admission never retries HTTP ${status} codes ${JSON.stringify(codes)}`, async () => {
    const http = provider([() => denied(1, status, [...codes])]);
    await assert.rejects(
      admitSourceNamespace(props, http.api, {
        wait: async () => assert.fail("unexpected retry"),
      }),
      /source-namespace-not-ready/,
    );
    assert.equal(http.calls.length, 1);
  });

for (const errors of [
  [...Array.from({ length: 10 }, () => ({ code: 10004 })), { code: 10000 }],
  [{ code: 10004 }, {}],
  [{ code: 10004 }, null],
  [{ code: 10004 }, { code: "10004" }],
])
  test(`namespace admission does not retry incomplete diagnostic codes ${JSON.stringify(errors)}`, async () => {
    const http = provider([() => Response.json({ success: false, errors }, { status: 403 })]);
    await assert.rejects(
      admitSourceNamespace(props, http.api, {
        wait: async () => assert.fail("unexpected retry"),
      }),
      /source-namespace-not-ready/,
    );
    assert.equal(http.calls.length, 1);
  });

test("namespace admission retries repeated 10004 entries only when every error has that code", async () => {
  const http = provider([() => denied(1, 403, Array(11).fill(10004)), readable, readable]);
  const waits: number[] = [];
  await admitSourceNamespace(props, http.api, {
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  assert.deepEqual(waits, [1000]);
  assert.equal(http.calls.length, 3);
});

for (const body of ["not-json private provider text", JSON.stringify({ success: true })])
  test(`namespace admission preserves HTTP metadata when a successful response cannot decode: ${body}`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "namespace-invalid-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const evidence = releaseEvidence(directory, "a".repeat(40));
    const http = provider([() => new Response(body, { headers: { "cf-ray": ray(1) } })]);
    const refusal = await admitSourceNamespace(props, http.api, {
      record: evidence.namespaceRead,
      wait: async () => assert.fail("unexpected retry"),
    }).then(
      () => assert.fail("expected refusal"),
      (error: unknown) => error,
    );
    const receipt = await evidence.failure(refusal);
    assert.equal(receipt.reason, "source-namespace-not-ready");
    assert.deepEqual(receipt.activated, []);
    assert.equal(http.calls.length, 1);
    assert.deepEqual(
      receipt.namespaceReads?.map((read) => [read.attempt, read.status, read.codes, read.ray]),
      [[1, 200, [], ray(1)]],
    );
    assert.doesNotMatch(JSON.stringify(receipt), /private provider text/);
  });
