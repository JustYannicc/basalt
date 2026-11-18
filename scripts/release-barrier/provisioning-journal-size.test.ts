// The bootstrap journals the namespace baseline in State, whose store keeps each output as one
// Durable Object value (2 MiB; real workerd answers "string or blob too big: SQLITE_TOOBIG"). The
// serving PoolWorker's entry module alone is about 1.6 MiB, so the baseline is read without module
// bodies, and an oversized value is refused by name before anything is written.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Effect } from "effect";
import type { StateService } from "alchemy/State/State";
import { canonical, digest } from "./manifest.ts";
import { decodeNamespaceBaseline } from "./provisioning-namespace.ts";
import { provisioningJournal } from "./provisioning-journal.ts";
import { stateProvisioningStore, stateValueLimit, storedStateBytes } from "./provisioning-state.ts";
import { journalKey } from "./forward-journal.ts";
import { namespaceBaseline } from "./test/provisioning-fixtures.ts";
import { runtimeNamespaceReader } from "./runtime-namespace-read.ts";
import { productionWorker, productionWorkerApi } from "./test/production-worker-api.ts";

const durableObjectValueLimit = 2 * 1024 * 1024;
const scope = { name: "basalt", stage: "production" };

/** A State whose setOutput refuses what the Durable Object would refuse. */
function durableObjectState(previous: unknown) {
  const writes: number[] = [];
  let output = previous;
  const state = {
    getOutput: () => Effect.succeed(output),
    setOutput: ({ value }: { value: unknown }) =>
      Effect.sync(() => {
        const bytes = storedStateBytes(value);
        writes.push(bytes);
        if (bytes > durableObjectValueLimit)
          throw new Error(`string or blob too big: SQLITE_TOOBIG (${bytes} bytes)`);
        output = structuredClone(value);
        return value;
      }),
  } as unknown as StateService;
  return { state, writes, output: () => output };
}

test("a baseline too large for one State value is refused by name and nothing is written", async () => {
  const fixture = namespaceBaseline();
  const modules = fixture.version.modules!;
  const baseline = decodeNamespaceBaseline({
    ...fixture,
    version: {
      ...fixture.version,
      modules: [
        {
          ...modules[0]!,
          contentBase64: randomBytes(Math.round(1623.8 * 1024)).toString("base64"),
        },
        ...modules.slice(1),
      ],
    },
  });
  const previous = {
    schemaVersion: 1,
    candidate: "e".repeat(40),
    manifest: "f".repeat(64),
    sealed: { synthetic: true },
    complete: true,
  };
  const db = durableObjectState(previous);
  const store = stateProvisioningStore(db.state, scope, "c".repeat(64), (work) => work());
  const journal = provisioningJournal(store, "a".repeat(40), "b".repeat(64), "PoolRuntimeBlue");
  await assert.rejects(
    journal.observe(
      "namespace-baseline",
      digest(canonical(baseline)),
      async () => baseline,
      decodeNamespaceBaseline,
    ),
    (error: Error) => {
      assert.match(error.message, /provisioning-journal-value-too-large/);
      assert.match(error.message, new RegExp(`journal\\.storedBytes \\d+ > ${stateValueLimit}`));
      return true;
    },
  );
  assert.deepEqual(db.writes, [], "no write reached State");
  assert.deepEqual(db.output(), previous, "the completed forward head is untouched");
  assert.ok(stateValueLimit < durableObjectValueLimit);
});

test("the production reader's baseline carries no module bodies and journals far below the limit", async () => {
  const worker = productionWorker({
    PoolRuntimeBlue: "blue-namespace",
    PoolRuntimeGreen: "green-namespace",
  });
  const api = productionWorkerApi(worker);
  const baseline = await Effect.runPromise(
    Effect.gen(function* () {
      const reader = yield* runtimeNamespaceReader(worker.accountId, worker.scriptName);
      return yield* Effect.promise(() => reader.baseline());
    }).pipe(Effect.provide(api.layer)),
  );
  assert.equal(baseline.version.modules, undefined);
  const db = durableObjectState(undefined);
  const store = stateProvisioningStore(db.state, scope, "c".repeat(64), (work) => work());
  const journal = provisioningJournal(store, "a".repeat(40), "b".repeat(64), "PoolRuntimeBlue");
  await journal.observe(
    "namespace-baseline",
    digest(canonical(baseline)),
    async () => baseline,
    decodeNamespaceBaseline,
  );
  assert.equal(db.writes.length, 1, "a read is journaled once, already acknowledged");
  assert.ok(db.writes[0]! < 64 * 1024, `${db.writes[0]} bytes`);
  assert.equal(journalKey(scope).stack, "basalt-release-barrier");
});
