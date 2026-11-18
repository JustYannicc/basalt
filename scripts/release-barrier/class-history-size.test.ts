import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { State, type StateService } from "alchemy/State/State";
import { encodeState } from "alchemy/State/StateEncoding";
import {
  classHistory,
  classStateValueLimit,
  saveClassHistory,
  type ClassRecord,
} from "./class-history.ts";
import { cloneRequest } from "./class-clone.ts";
import {
  contentDigest,
  expansionContent,
  expansionRequest,
  payloadDigest,
} from "./class-payload.ts";
import { classRecoveryRequest, restoreClassRecord } from "./class-recovery.ts";
import type { ClassContent, ClassObservation } from "./declared-class-contract.ts";
import type { SqliteClassDeclaration } from "./declared-change-schema.ts";
import { canonical, digest } from "./manifest.ts";

// The class record lives in the stack output, which alchemy's Cloudflare State store writes as ONE
// Durable Object value (JSON, AES-CTR, base64; no chunking). Real workerd refuses a value over
// 2 MiB with SQLITE_TOOBIG. Production's serving PoolWorker is about 1.7 MB of entry module plus a
// 4.9 MB source map, and the record used to carry it twice as base64 (about 23 MB stored).

const DURABLE_OBJECT_VALUE_LIMIT = 2 * 1024 * 1024;
const scope = { stack: "basalt", stage: "production" };

const entry = {
  action: "add-sqlite-class",
  type: "Cloudflare.Worker",
  fqn: "PoolWorker",
  newSqliteClasses: ["PoolRuntimeBlue", "PoolRuntimeGreen"],
  addedBindings: ["PoolRuntimeBlue", "PoolRuntimeGreen"].map((name) => ({
    type: "durable_object_namespace",
    name,
    className: name,
    location: "local",
  })),
  retention: { data: true, nativeStateRow: true, recoveryDescriptor: true },
} as unknown as SqliteClassDeclaration;

const observed: ClassObservation = {
  workerId: "immutable-worker",
  accountId: "fixture-account",
  scriptName: "fixture-worker",
  versionId: "active",
  settings: {
    compatibilityDate: "2026-09-08",
    compatibilityFlags: ["nodejs_compat", "new_module_registry"],
    usageModel: "standard",
    tags: ["alchemy:stack:basalt", "alchemy:stage:production", "alchemy:id:PoolWorker"],
    bindings: [],
  },
  previewUrlsEnabled: false,
  containers: [{ className: "PoolContainer" }],
};

/** The store's own framing of one stack output value (Store.ts encryptValue): nonce + JSON, base64. */
const storedBytes = (value: unknown) =>
  Math.ceil((Buffer.byteLength(JSON.stringify(encodeState(value))) + 16) / 3) * 4;

function baselineContent(entryBytes: number, mapBytes: number): ClassContent {
  const tail = "export{PoolContainer,e_ as default};";
  return {
    mainModule: "worker.js",
    files: [
      {
        name: "worker.js",
        type: "application/javascript+module",
        bytes: new TextEncoder().encode("/".repeat(2) + "a".repeat(entryBytes) + "\n" + tail),
      },
      ...(mapBytes
        ? [
            {
              name: "worker.js.map",
              type: "application/source-map",
              bytes: new Uint8Array(mapBytes).fill(97),
            },
          ]
        : []),
    ],
  };
}

/** The descriptor class-preparation.ts freezes on a first run, bytes included in memory. */
function record(baseline: ClassContent): ClassRecord {
  const content = expansionContent(baseline, entry);
  const marker = `basalt-declared:${"a".repeat(40)}:${"b".repeat(64)}`;
  const request = expansionRequest(observed, content, entry, undefined, [], marker);
  const clone = cloneRequest(observed, baseline, marker, entry.fqn);
  return {
    entry: digest(canonical(entry)),
    declaration: "c".repeat(64),
    candidate: "a".repeat(40),
    native: { instanceId: "instance", workerId: observed.workerId, providerVersion: 0 },
    baseline: observed,
    marker,
    content: contentDigest(content),
    payload: payloadDigest(request, content),
    tags: [...(request.metadata.tags ?? [])],
    recovery: {
      metadata: request.metadata,
      mainModule: content.mainModule,
      files: content.files.map((file) => ({
        name: file.name,
        type: file.type,
        base64: Buffer.from(file.bytes).toString("base64"),
      })),
    },
    clone: { request: clone, payload: digest(canonical(clone)), status: "pending" },
    status: "clone-pending",
  };
}

/** A State whose setOutput refuses what the Durable Object refuses. */
function durableObjectState(previous?: unknown) {
  let output = previous;
  const sizes: number[] = [];
  const state = {
    getOutput: () => Effect.succeed(output),
    setOutput: (input: { value: unknown }) =>
      Effect.suspend(() => {
        const bytes = storedBytes(input.value);
        sizes.push(bytes);
        if (bytes > DURABLE_OBJECT_VALUE_LIMIT)
          return Effect.fail(new Error(`string or blob too big: SQLITE_TOOBIG (${bytes} bytes)`));
        output = structuredClone(input.value);
        return Effect.succeed(input.value);
      }),
  } as unknown as StateService;
  return { state, sizes, output: () => output };
}

const save = (db: ReturnType<typeof durableObjectState>, value: ClassRecord) =>
  Effect.runPromise(
    saveClassHistory(scope, entry.fqn, value).pipe(
      Effect.provideService(State, Effect.succeed(db.state)),
    ),
  );

for (const [shape, entryBytes, mapBytes] of [
  ["production: 1.7 MB entry + 4.9 MB source map", 1_700_000, 4_900_000],
  ["control: a 100 KB Worker", 100_000, 0],
] as const)
  test(`the class record fits one State value and its bytes come back from the baseline (${shape})`, async () => {
    const baseline = baselineContent(entryBytes, mapBytes);
    const original = record(baseline);
    const db = durableObjectState();
    // class-clone.ts prepareClassClone: the first State write of the class step, before any Worker write.
    await save(db, original);
    assert.equal(db.sizes.length, 1);
    assert.ok(db.sizes[0]! <= classStateValueLimit, `${db.sizes[0]} bytes`);
    assert.ok(classStateValueLimit < DURABLE_OBJECT_VALUE_LIMIT);

    const stored = classHistory(db.output())[entry.fqn]!;
    assert.ok(stored.recovery.files.every((file) => file.base64 === ""));
    assert.ok(stored.clone.request.modules?.every((module) => module.contentBase64 === ""));
    // A stored record alone cannot produce a PUT: the digests refuse empty bytes.
    assert.throws(() => classRecoveryRequest(stored, entry.fqn), /declared-class-recovery-invalid/);

    // A rerun re-reads the frozen baseline version and gets the exact request bytes back.
    const restored = restoreClassRecord(stored, baseline, entry, entry.fqn);
    assert.deepEqual(restored.recovery, original.recovery);
    assert.deepEqual(restored.clone.request, original.clone.request);
    assert.equal(
      payloadDigest(classRecoveryRequest(restored), {
        mainModule: restored.recovery.mainModule,
        files: restored.recovery.files.map((file) => ({
          ...file,
          bytes: new Uint8Array(Buffer.from(file.base64, "base64")),
        })),
      }),
      original.payload,
    );
  });

test("a baseline whose bytes differ from the saved digests is refused by name", async () => {
  const baseline = baselineContent(1000, 0);
  const db = durableObjectState();
  await save(db, record(baseline));
  const stored = classHistory(db.output())[entry.fqn]!;
  const drifted: ClassContent = {
    ...baseline,
    files: baseline.files.map((file) => ({
      ...file,
      bytes: new TextEncoder().encode(new TextDecoder().decode(file.bytes).replace("a", "b")),
    })),
  };
  assert.throws(
    () => restoreClassRecord(stored, drifted, entry, entry.fqn),
    (error: Error & { delta?: { changed: { path: string }[] } }) => {
      assert.match(error.message, /declared-class-recovery-invalid/);
      assert.ok(error.delta?.changed.some((change) => change.path === "recovery.contentHash"));
      return true;
    },
  );
});

test("a stack output too large for one State value is refused by name and nothing is written", async () => {
  const previous = { unrelated: "x".repeat(DURABLE_OBJECT_VALUE_LIMIT) };
  const db = durableObjectState(previous);
  await assert.rejects(save(db, record(baselineContent(1000, 0))), (error: Error) => {
    assert.match(String(error), /declared-class-history-too-large/);
    return true;
  });
  assert.deepEqual(db.sizes, [], "no write reached State");
  assert.deepEqual(db.output(), previous);
});
