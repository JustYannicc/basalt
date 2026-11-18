// The bootstrap journals the namespace baseline in State, whose store keeps each output as one
// Durable Object value (2 MiB; real workerd answers "string or blob too big: SQLITE_TOOBIG"). The
// serving PoolWorker's entry module alone is about 1.6 MiB, so the baseline is read without module
// bodies, and an oversized value is refused by name before anything is written.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Effect } from "effect";
import type { StateService } from "alchemy/State/State";
import { encodeState } from "alchemy/State/StateEncoding";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { decodeNamespaceBaseline } from "./provisioning-namespace.ts";
import { provisioningManifestDigest } from "./provisioning-contract.ts";
import { stateProvisioningStore } from "./provisioning-state.ts";
import { provisionRuntime, type RuntimeProvisioningProvider } from "./runtime-provisioning.ts";
import { provisioningFixture } from "./test/provisioning-fixtures.ts";
import { runtimeNamespaceReader } from "./runtime-namespace-read.ts";
import { productionWorker, productionWorkerApi } from "./test/production-worker-api.ts";

const durableObjectValueLimit = 2 * 1024 * 1024;

/** What the State store hands to storage.put: base64 of a 16-byte nonce and the encrypted JSON. */
const storedBytes = (value: unknown) =>
  Math.ceil((16 + Buffer.byteLength(JSON.stringify(encodeState(value)))) / 3) * 4;

/** A State whose setOutput refuses what the Durable Object would refuse. */
function durableObjectState(previous: unknown) {
  const writes: number[] = [];
  let output = previous;
  const state = {
    getOutput: () => Effect.succeed(output),
    setOutput: ({ value }: { value: unknown }) =>
      Effect.sync(() => {
        const bytes = storedBytes(value);
        writes.push(bytes);
        if (bytes > durableObjectValueLimit)
          throw new Error(`string or blob too big: SQLITE_TOOBIG (${bytes} bytes)`);
        output = structuredClone(value);
        return value;
      }),
  } as unknown as StateService;
  return { state, writes, output: () => output };
}

test("a baseline too large for one State value refuses by name and writes nothing", async () => {
  const f = provisioningFixture("PoolRuntimeBlue");
  const baseline = decodeNamespaceBaseline({
    ...f.baseline,
    version: {
      ...f.baseline.version,
      modules: [
        {
          name: f.baseline.version.mainModule,
          contentType: "application/javascript+module",
          contentBase64: randomBytes(Math.round(1623.8 * 1024)).toString("base64"),
        },
      ],
    },
  });
  const manifest = { ...f.manifest, namespaceBaselineDigest: digest(canonical(baseline)) };
  const enable = { ...f.enable, manifest: provisioningManifestDigest(manifest) };
  const previous = {
    schemaVersion: 1,
    candidate: "e".repeat(40),
    manifest: "f".repeat(64),
    sealed: { synthetic: true },
    complete: true,
  };
  const db = durableObjectState(previous);
  const scope = { name: manifest.stack, stage: manifest.stage };
  const store = stateProvisioningStore(db.state, scope, "c".repeat(64), (work) => work());
  let creates = 0;
  const unreachable = async () => assert.fail("no provider write or read-back may follow");
  const provider: RuntimeProvisioningProvider = {
    active: async () => manifest.active,
    namespaceBaseline: async () => baseline,
    observeNamespace: unreachable,
    applicationAbsent: unreachable,
    createApplication: async () => {
      creates++;
      return unreachable();
    },
    readApplication: unreachable,
    nativeState: unreachable,
    createdApplication: unreachable,
  };
  const outcome = await provisionRuntime(manifest, store, provider, enable, () => 100).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(outcome instanceof BarrierRefusal, `refused with ${String(outcome)}`);
  assert.equal(outcome.reason, "provisioning-journal-value-too-large");
  assert.match(outcome.message, /journal\.storedBytes \d+ > \d+/);
  assert.deepEqual(db.writes, [], "no write reached State");
  assert.deepEqual(db.output(), previous, "the completed forward head is untouched");
  assert.equal(creates, 0);
});

test("the production reader's baseline carries no module bodies", async () => {
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
  assert.ok(storedBytes(baseline) < 64 * 1024, `${storedBytes(baseline)} bytes`);
});
