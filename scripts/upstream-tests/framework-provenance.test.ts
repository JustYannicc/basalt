import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { FrameworkProvenanceRefused } from "../../.upstream/packages/sdk/src/contracts/runtime.ts";
import type { FrameworkProvenance } from "../../.upstream/packages/sdk/src/contracts/framework-provenance.ts";
import { BuildId } from "../../.upstream/packages/sdk/src/contracts/shared.ts";
import {
  LoadedWorkerBuild,
  type RetainedWorkerBuild,
} from "../../.upstream/packages/sdk/src/contracts/worker-build.ts";
import {
  FrameworkProvenanceRegistry,
  admitFramework,
  admitLoadedFramework,
  frameworkProvenanceRegistry,
  selectFrameworkProtocol,
} from "../../.upstream/packages/sdk/src/implementation/framework-provenance.ts";
import {
  frameworkIdentity,
  linkWorkerBuild,
} from "../../.upstream/packages/sdk/src/implementation/worker-build-storage.ts";
import {
  encodeLoadedBuild,
  runnerReply,
  runnerResult,
} from "../../.upstream/packages/sdk/src/implementation/remote-app-runner.ts";

const build = BuildId.make("bld_provenance_fixture");
const fixture = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const version = "0.0.1-beta.104-basalt.14";
      const modules = { "node_modules/apps/index.js": "export const framework = 'synthetic';" };
      const browser = { "node_modules/apps/browser.js": "export const browser = 'synthetic';" };
      const identity = yield* frameworkIdentity({ version, modules });
      const browserIdentity = yield* frameworkIdentity({ version, modules: browser });
      const release: FrameworkProvenance = {
        ...identity,
        protocol: 40,
        browserSha256: browserIdentity.sha256,
        source: { origin: "basalt", revision: "synthetic-reviewed-source", sha256: "1".repeat(64) },
      };
      const loaded: LoadedWorkerBuild = {
        mainModule: "app.js",
        modules: { ...modules, "app.js": "export default {};" },
        protocol: 40,
        framework: release,
      };
      return { version, modules, browser, identity, release, loaded };
    }),
  );

const run = <A, E>(effect: Effect.Effect<A, E>, releases: readonly FrameworkProvenance[] = []) =>
  Effect.runPromise(effect.pipe(Effect.provideService(FrameworkProvenanceRegistry, releases)));

const refused = <A>(
  effect: Effect.Effect<A, FrameworkProvenanceRefused>,
  releases: readonly FrameworkProvenance[] = [],
) =>
  run(
    effect.pipe(
      Effect.match({
        onSuccess: () => assert.fail("framework admission unexpectedly succeeded"),
        onFailure: (error) => error,
      }),
    ),
    releases,
  );

test("admission checks exact server, browser, protocol and immutable source evidence", async () => {
  const f = await fixture();
  const registry = await Effect.runPromise(frameworkProvenanceRegistry([f.release]));
  assert.ok(Object.isFrozen(registry));
  assert.ok(Object.isFrozen(registry[0]?.source));
  const admitted = await run(
    admitFramework({
      framework: { version: f.version, modules: f.modules },
      protocol: 40,
      browser: f.browser,
    }),
    registry,
  );
  assert.deepEqual(admitted, f.release);
  assert.equal((await run(selectFrameworkProtocol(f.loaded), registry)).version, 40);
});

test("neither a Basalt suffix nor raw upstream protocol14 grants admission", async () => {
  const f = await fixture();
  for (const [version, protocol] of [
    [f.version, 40],
    ["0.0.1-beta.122", 14],
  ] as const) {
    let entered = false;
    const error = await refused(
      admitFramework({ framework: { version, modules: f.modules }, protocol }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            entered = true;
          }),
        ),
      ),
    );
    assert.equal(error.reason, "unknown-identity");
    assert.equal(error.version, version);
    assert.equal(error.protocol, protocol);
    assert.equal(entered, false);
  }
});

test("forged source, changed server bytes and wrong protocol have distinct typed refusals", async () => {
  const f = await fixture();
  const forged = {
    ...f.loaded,
    framework: { ...f.release, source: { ...f.release.source, revision: "forged" } },
  };
  assert.equal(
    (await refused(admitLoadedFramework(forged, { build }), [f.release])).reason,
    "conflicting-lineage",
  );
  const changed = {
    ...f.loaded,
    modules: { ...f.loaded.modules, "node_modules/apps/index.js": "changed" },
  };
  const corrupt = await refused(admitLoadedFramework(changed, { build }), [f.release]);
  assert.equal(corrupt.reason, "content-mismatch");
  assert.equal(corrupt.build, build);
  assert.equal(corrupt.declaredHash, f.identity.sha256);
  assert.notEqual(corrupt.computedHash, f.identity.sha256);
  assert.equal(
    (await refused(admitLoadedFramework({ ...f.loaded, protocol: 14 }), [f.release])).reason,
    "protocol-mismatch",
  );
  const browser = await refused(
    admitFramework({
      framework: { version: f.version, modules: f.modules },
      protocol: 40,
      browser: {},
    }),
    [f.release],
  );
  assert.equal(browser.reason, "content-mismatch");
  assert.match(browser.message, /browser SHA-256/u);
});

test("format2 rechecks both stored identity fields and recomputes module bytes", async () => {
  const f = await fixture();
  const stored: RetainedWorkerBuild = {
    format: 2,
    mainModule: "app.js",
    modules: { "app.js": "export default {};" },
    database: false,
    protocol: 40,
    framework: f.identity,
  };
  const framework = { ...f.identity, modules: f.modules };
  const loaded = await run(
    linkWorkerBuild(stored, () => Effect.succeed(framework), build),
    [f.release],
  );
  assert.deepEqual(loaded.framework, f.release);
  for (const bad of [
    { ...framework, version: "0.0.1-beta.122" },
    { ...framework, sha256: "f".repeat(64) },
    { ...framework, modules: { "node_modules/apps/index.js": "corrupt" } },
  ]) {
    const error = await refused(
      linkWorkerBuild(stored, () => Effect.succeed(bad), build),
      [f.release],
    );
    assert.equal(error.build, build);
    assert.ok(["conflicting-lineage", "content-mismatch"].includes(error.reason));
  }
});

test("format1 needs exact approved bytes and does not infer lineage from implicit protocol1", async () => {
  const f = await fixture();
  const inlined = { format: 1 as const, ...f.loaded, database: false };
  const loaded = await run(
    linkWorkerBuild(inlined, () => assert.fail("format1 read an external framework"), build),
    [f.release],
  );
  assert.deepEqual(loaded.framework, f.release);
  const unknown = await refused(
    linkWorkerBuild(inlined, () => assert.fail("format1 read an external framework"), build),
  );
  assert.equal(unknown.reason, "unknown-identity");
  const implicit = await refused(
    linkWorkerBuild({ ...inlined, protocol: 1 }, () => assert.fail(), build),
    [f.release],
  );
  assert.equal(implicit.reason, "protocol-mismatch");
});

test("old transport records decode but missing provenance refuses before execution", async () => {
  const f = await fixture();
  const { framework: _framework, ...legacy } = f.loaded;
  const decoded = Schema.decodeUnknownSync(LoadedWorkerBuild)(legacy);
  const error = await refused(admitLoadedFramework(decoded, { build }), [f.release]);
  assert.equal(error.reason, "missing-identity");
  assert.equal(error.build, build);
  const roundTrip = Schema.decodeUnknownSync(Schema.fromJsonString(LoadedWorkerBuild))(
    encodeLoadedBuild(f.loaded),
  );
  assert.deepEqual(roundTrip.framework, f.release);
});

test("warm build admission refuses a changed tuple even when the replacement has registry evidence", async () => {
  const f = await fixture();
  const replacement = { ...f.release, source: { ...f.release.source, sha256: "2".repeat(64) } };
  const error = await refused(
    admitLoadedFramework({ ...f.loaded, framework: replacement }, { build, previous: f.release }),
    [replacement],
  );
  assert.equal(error.reason, "conflicting-lineage");
  assert.match(error.message, /immutable build/u);
});

test("remote failure transport preserves the provenance reason, tuple and build ID", async () => {
  const f = await fixture();
  const error = await refused(admitLoadedFramework({ ...f.loaded, protocol: 14 }, { build }), [
    f.release,
  ]);
  const decoded = await Effect.runPromise(
    runnerResult(runnerReply(Effect.fail(error))).pipe(
      Effect.match({
        onSuccess: () => assert.fail("remote refusal unexpectedly succeeded"),
        onFailure: (failure) => failure,
      }),
    ),
  );
  assert.ok(Schema.is(FrameworkProvenanceRefused)(decoded));
  assert.equal(decoded.reason, error.reason);
  assert.equal(decoded.build, build);
  assert.equal(decoded.declaredHash, error.declaredHash);
  assert.equal(decoded.computedHash, error.computedHash);
});
