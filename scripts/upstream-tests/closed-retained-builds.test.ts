import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { BuildId } from "../../.upstream/packages/sdk/src/contracts/shared.ts";
import { BlobStore } from "../../.upstream/packages/sdk/src/contracts/blobs.ts";
import type { CommittedRetainedBuildPin } from "../../.upstream/packages/sdk/src/contracts/unverified-retained-build.ts";
import type { RetainedWorkerBuild } from "../../.upstream/packages/sdk/src/contracts/worker-build.ts";
import { memoryBlobStore } from "../../.upstream/packages/sdk/src/implementation/memory-blobs.ts";
import { closedRetainedBuilds } from "../../.upstream/packages/sdk/src/implementation/closed-retained-builds.ts";
import {
  FrameworkProvenanceRegistry,
  selectFrameworkProtocol,
} from "../../.upstream/packages/sdk/src/implementation/framework-provenance.ts";
import {
  buildKey,
  frameworkIdentity,
  linkWorkerBuild,
  retainWorkerBuild,
} from "../../.upstream/packages/sdk/src/implementation/worker-build-storage.ts";
import {
  selectInvocationFrameworkProtocol,
  verifyFixedRetainedBuild,
} from "../../.upstream/packages/sdk/src/implementation/unverified-retained-build.ts";

const retainedPool = closedRetainedBuilds.find((entry) => entry.policy === "pin-first-observation");
assert.ok(retainedPool);
const pool = retainedPool;
const refused = async <A, E>(operation: Effect.Effect<A, E>) => {
  const result = await Effect.runPromise(
    operation.pipe(
      Effect.match({
        onFailure: (error) => ({ error }),
        onSuccess: () => assert.fail("An unqualified build was admitted"),
      }),
    ),
  );
  assert.ok(typeof result.error === "object" && result.error !== null && "_tag" in result.error);
  assert.equal(result.error._tag, "FrameworkProvenanceRefused");
};

async function fixture() {
  const framework = {
    version: "synthetic-unverified",
    modules: {
      "node_modules/apps/index.js": "export const retained = true;",
    },
  };
  const identity = await Effect.runPromise(frameworkIdentity(framework));
  const record: RetainedWorkerBuild = {
    format: 2,
    mainModule: "app.js",
    modules: { "app.js": "export default {};" },
    database: false,
    framework: identity,
    protocol: 42,
  };
  const pin: CommittedRetainedBuildPin = {
    app: pool.app,
    build: pool.build,
    tuple: { ...identity, protocol: record.protocol },
  };
  const load = (build = pool.build) =>
    linkWorkerBuild(
      record,
      () => Effect.succeed({ ...framework, ...identity }),
      BuildId.make(build),
      () => Effect.succeed(pin),
    );
  return { framework, record, pin, load };
}

test("fixed retained builds require their exact tuples and cannot share their exception", async () => {
  for (const entry of closedRetainedBuilds) {
    if (entry.policy !== "fixed-tuple") continue;
    const marker = await Effect.runPromise(verifyFixedRetainedBuild(entry.build, entry.tuple));
    assert.equal(marker.app, entry.app);
    assert.equal(marker.reason, "active at sync, provenance unproven");
    await refused(verifyFixedRetainedBuild("bld_unlisted_same_tuple", entry.tuple));
    await refused(
      verifyFixedRetainedBuild(entry.build, { ...entry.tuple, sha256: "0".repeat(64) }),
    );
    await refused(
      verifyFixedRetainedBuild(entry.build, { ...entry.tuple, protocol: entry.tuple.protocol + 1 }),
    );
  }
});

test("a listed retained pool loads and selects its protocol while an unlisted build with the same bytes refuses", async () => {
  const f = await fixture();
  const loaded = await Effect.runPromise(f.load());
  assert.equal(loaded.framework, undefined);
  assert.deepEqual(loaded.unverified?.tuple, f.pin.tuple);
  const protocol = await Effect.runPromise(
    selectInvocationFrameworkProtocol(loaded, pool, () => Effect.succeed(f.pin)),
  );
  assert.equal(protocol.version, 42);
  await refused(f.load("bld_unlisted_same_tuple"));
  await refused(
    selectInvocationFrameworkProtocol(loaded, { ...pool, app: "app_someone_else" }, () =>
      assert.fail("A different app must refuse before committing a pin"),
    ),
  );
  await refused(
    selectInvocationFrameworkProtocol(
      { ...loaded, unverified: { ...loaded.unverified!, build: BuildId.make("bld_tampered") } },
      pool,
      () => assert.fail("A tampered marker must refuse before committing a pin"),
    ),
  );
  await refused(selectInvocationFrameworkProtocol(loaded, pool));
  await refused(
    selectInvocationFrameworkProtocol(
      {
        ...loaded,
        modules: {
          ...loaded.modules,
          "node_modules/apps/index.js": "export const changed = true;",
        },
      },
      pool,
      () => assert.fail("Changed bytes must refuse before committing a pin"),
    ),
  );
});

test("retained permission never admits a redeploy or a new declaration", async () => {
  const f = await fixture();
  const loaded = await Effect.runPromise(f.load());
  await refused(selectFrameworkProtocol(loaded));
  const blobs = memoryBlobStore();
  for (const build of [pool.build, "bld_new_deploy_same_tuple"]) {
    await refused(
      retainWorkerBuild(BuildId.make(build), f.record, f.framework, undefined).pipe(
        Effect.provideService(FrameworkProvenanceRegistry, []),
        Effect.provideService(BlobStore, blobs),
      ),
    );
    assert.equal(
      await Effect.runPromise(buildKey(BuildId.make(build)).pipe(Effect.flatMap(blobs.exists))),
      false,
    );
  }
});
