import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { readDeclaredBucket } from "./bucket-cloudflare.ts";
import { bucketRead } from "./bucket-failure.ts";
import { retryingBucketReads, type BucketRead } from "./bucket-read.ts";
import type { BucketObservation, BucketProvider, BucketTarget } from "./declared-buckets.ts";
import { releaseEvidence } from "./evidence.ts";
import { BarrierRefusal } from "./manifest.ts";

const target: BucketTarget = {
  accountId: "synthetic-account",
  bucketName: "synthetic-bucket",
  jurisdiction: "eu",
  storageClass: "Standard",
};
const observation = {
  attributes: {
    ...target,
    location: "weur",
    domains: [],
    cors: [],
    lifecycleRules: [],
    publicDomain: undefined,
  },
  publicAccess: false,
} satisfies BucketObservation;
const changed = (error: unknown) =>
  error instanceof BarrierRefusal ? error.delta?.changed : assert.fail("expected a refusal");

/** A provider whose reads answer in turn; creates and configures count their calls. */
const provider = (reads: Array<() => Promise<BucketObservation | undefined>>) => {
  const calls = { read: 0, create: 0, configure: 0 };
  const base: BucketProvider = {
    accountId: async () => target.accountId,
    read: async () => (calls.read++, reads.shift()!()),
    create: async () => {
      calls.create++;
      throw new Cause.TimeoutError();
    },
    configure: async () => {
      calls.configure++;
      throw new Cause.TimeoutError();
    },
  };
  return { calls, base };
};

test("the real R2 SDK's stalled and locked reads are refused by name, not as unknown", async () => {
  // A 423 through the real SDK, and Effect's timeout that the read's own bounded wait raises.
  const client = HttpClient.make((request) =>
    Effect.succeed(
      HttpResponse.fromWeb(request, new Response("<html>locked</html>", { status: 423 })),
    ),
  );
  const locked = await Effect.runPromise(
    readDeclaredBucket(target).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(
        Credentials,
        Effect.succeed({
          type: "apiToken",
          apiToken: Redacted.make("synthetic-never-sent"),
          apiBaseUrl: "https://api.cloudflare.com/client/v4",
        }),
      ),
    ),
  ).then(
    () => assert.fail("a locked bucket read must fail"),
    (error: unknown) => error,
  );
  for (const [error, type] of [
    [locked, "Locked"],
    [new Cause.TimeoutError(), "TimeoutError"],
  ] as const) {
    const refusal = await bucketRead("VaultAttachments", () => Promise.reject(error)).catch(
      (failure: unknown) => failure,
    );
    assert.deepEqual(changed(refusal), [
      { path: "$operation", old: null, new: "read-bucket" },
      { path: "$provider.type", old: null, new: type },
    ]);
  }
});

test("a stalled bucket read recovers on attempt two and records each attempt's type", async () => {
  const reads: BucketRead[] = [];
  const waits: number[] = [];
  const { calls, base } = provider([
    () => Promise.reject(new Cause.TimeoutError()),
    async () => observation,
  ]);
  const buckets = retryingBucketReads(base, {
    record: async (read) => void reads.push(read),
    wait: async (ms) => void waits.push(ms),
    random: () => 0,
  });
  assert.equal(await buckets.read(target, "VaultAttachments"), observation);
  assert.equal(calls.read, 2);
  assert.deepEqual(
    reads.map(({ fqn, attempt, outcome }) => ({ fqn, attempt, outcome })),
    [
      { fqn: "VaultAttachments", attempt: 1, outcome: "TimeoutError" },
      { fqn: "VaultAttachments", attempt: 2, outcome: "ok" },
    ],
  );
  assert.deepEqual(waits, [1000]);
});

test("a read that stays stalled refuses after three attempts, naming its type in the receipt", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bucket-read-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = releaseEvidence(directory, "a".repeat(40));
  const { calls, base } = provider(
    Array.from({ length: 3 }, () => () => Promise.reject(new Cause.TimeoutError())),
  );
  const waits: number[] = [];
  const buckets = retryingBucketReads(base, {
    record: evidence.bucketRead,
    wait: async (ms) => void waits.push(ms),
    random: () => 0,
  });
  const refusal = await bucketRead("VaultAttachments", () =>
    buckets.read(target, "VaultAttachments"),
  ).catch((error: unknown) => error);
  assert.equal(calls.read, 3);
  assert.deepEqual(waits, [1000, 2000]);
  await evidence.failure(refusal);
  const failure = JSON.parse(await readFile(join(directory, "failure.json"), "utf8"));
  assert.equal(failure.reason, "declared-bucket-provider-failed");
  assert.deepEqual(failure.delta.changed, [
    { path: "$operation", old: null, new: "read-bucket" },
    { path: "$provider.type", old: null, new: "TimeoutError" },
  ]);
  assert.deepEqual(
    failure.bucketReads.map(({ attempt, outcome }: BucketRead) => ({ attempt, outcome })),
    [1, 2, 3].map((attempt) => ({ attempt, outcome: "TimeoutError" })),
  );
});

test("policy drift, refused access and writes are never retried", async (context) => {
  const drift = new BarrierRefusal("declared-bucket-policy-drift", "VaultAttachments");
  const forbidden = Object.assign(new Error("private"), { _tag: "Forbidden" });
  for (const error of [drift, forbidden]) {
    // Through the real evidence writer, so a recording it refuses would surface here.
    const directory = await mkdtemp(join(tmpdir(), "bucket-read-final-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const evidence = releaseEvidence(directory, "a".repeat(40));
    const { calls, base } = provider([() => Promise.reject(error), async () => observation]);
    const buckets = retryingBucketReads(base, {
      record: evidence.bucketRead,
      wait: async () => assert.fail("no wait before a final failure"),
    });
    await assert.rejects(buckets.read(target, "VaultAttachments"), (thrown) => thrown === error);
    assert.equal(calls.read, 1);
    const recorded = JSON.parse(await readFile(join(directory, "bucket-reads.json"), "utf8"));
    assert.deepEqual(
      recorded.reads.map(({ attempt, outcome, refusal }: BucketRead) => ({
        attempt,
        outcome,
        refusal,
      })),
      [
        error === drift
          ? { attempt: 1, outcome: "refused", refusal: "declared-bucket-policy-drift" }
          : { attempt: 1, outcome: "Forbidden", refusal: undefined },
      ],
    );
  }
  const { calls, base } = provider([]);
  const buckets = retryingBucketReads(base, { wait: async () => assert.fail("writes never wait") });
  await assert.rejects(buckets.create(target));
  await assert.rejects(buckets.configure(target));
  assert.deepEqual(calls, { read: 0, create: 1, configure: 1 });
});

test("a bucket removed between its reads is refused as NoSuchBucket, once", async () => {
  // The real SDK: the bucket exists for the first read, then its domain listing finds it gone.
  let calls = 0;
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      calls++;
      if (url.pathname.endsWith("/domains/managed"))
        return HttpResponse.fromWeb(
          request,
          Response.json(
            { success: false, errors: [{ code: 10006, message: "private provider text" }] },
            { status: 404 },
          ),
        );
      return HttpResponse.fromWeb(
        request,
        Response.json({
          success: true,
          errors: [],
          messages: [],
          result: { name: target.bucketName, jurisdiction: "eu", storage_class: "Standard" },
        }),
      );
    }),
  );
  const real: BucketProvider = {
    ...provider([]).base,
    read: (bucket, fqn) =>
      Effect.runPromise(
        readDeclaredBucket(bucket, fqn).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(
            Credentials,
            Effect.succeed({
              type: "apiToken",
              apiToken: Redacted.make("synthetic-never-sent"),
              apiBaseUrl: "https://api.cloudflare.com/client/v4",
            }),
          ),
        ),
      ),
  };
  const reads: BucketRead[] = [];
  const buckets = retryingBucketReads(real, {
    record: async (read) => void reads.push(read),
    wait: async () => assert.fail("a missing bucket is final"),
  });
  const refusal = await bucketRead("VaultAttachments", () =>
    buckets.read(target, "VaultAttachments"),
  ).catch((error: unknown) => error);
  assert.equal(calls, 2);
  assert.deepEqual(changed(refusal), [
    { path: "$operation", old: null, new: "read-bucket" },
    { path: "$provider.type", old: null, new: "NoSuchBucket" },
    { path: "$provider.codes.0", old: null, new: 10006 },
  ]);
  assert.deepEqual(
    reads.map(({ outcome }) => outcome),
    ["NoSuchBucket"],
  );
});

test("plan resource names of any shape are recorded without failing the release", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bucket-read-names-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = releaseEvidence(directory, "a".repeat(40));
  for (const fqn of ["Storage/VaultAttachments", `Nested/${"Deep/".repeat(60)}Bucket`]) {
    const { base } = provider([async () => observation]);
    const buckets = retryingBucketReads(base, { record: evidence.bucketRead });
    assert.equal(await buckets.read(target, fqn), observation);
  }
  const recorded = JSON.parse(await readFile(join(directory, "bucket-reads.json"), "utf8"));
  assert.deepEqual(
    recorded.reads.map(({ fqn, outcome }: BucketRead) => ({ fqn, outcome })),
    [
      { fqn: "Storage/VaultAttachments", outcome: "ok" },
      { fqn: `Nested/${"Deep/".repeat(60)}Bucket`, outcome: "ok" },
    ],
  );
});
