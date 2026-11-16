import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import {
  PublishedAppFramework,
  RetainedFramework,
} from "../../.upstream/packages/sdk/src/contracts/worker-build.ts";
import { FrameworkProvenanceRefused } from "../../.upstream/packages/sdk/src/contracts/runtime.ts";
import { canonicalFrameworkReleases } from "../../.upstream/packages/sdk/src/implementation/basalt-framework-releases.ts";
import { frameworkIdentity } from "../../.upstream/packages/sdk/src/implementation/framework-identity.ts";
import { runnerResult } from "../../.upstream/packages/sdk/src/implementation/remote-app-runner.ts";
import { qualifiedFrameworkRegistry } from "../deploy-safety/framework-registry.ts";
import {
  bundleRegistryRunner,
  registryAuthoredBundle,
} from "./framework-registry-runner-fixture.ts";

const require = createRequire(
  new URL("../../.upstream/packages/sdk/package.json", import.meta.url),
);
process.env.MINIFLARE_WORKERD_PATH ??= require("workerd").default;
const { Miniflare } = require("miniflare") as typeof import("miniflare");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

async function producer(runtime: typeof PublishedAppFramework.Type, name: string) {
  const module = Object.keys(runtime.server).sort()[0];
  assert.ok(module, "The built framework must contain server modules");
  const modules = {
    ...runtime.server,
    [module]: `${runtime.server[module]}\n// Qualified release ${name}.\n`,
  };
  const publication = { ...runtime, server: modules };
  const identity = await Effect.runPromise(
    frameworkIdentity({ version: runtime.version, modules }),
  );
  const browser = await Effect.runPromise(
    frameworkIdentity({ version: runtime.version, modules: runtime.browser }),
  );
  return {
    modules,
    artifacts: {
      runtimeJsonSha256: digest(JSON.stringify(publication)),
      frameworkJsonSha256: digest(`package-${name}`),
    },
    release: {
      ...identity,
      protocol: runtime.protocol,
      browserSha256: browser.sha256,
      source: {
        origin: "basalt" as const,
        revision: `synthetic-qualified-${name}`,
        sha256: digest(JSON.stringify(publication)),
      },
    },
  };
}

test(
  "cumulative defaults run retained A through B and failed C through D and refuse tampered bytes",
  {
    skip:
      process.env.BASALT_CHECK_BUILT_FRAMEWORK !== "1"
        ? "The production framework build runs this proof"
        : false,
    timeout: 30_000,
  },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "basalt-qualified-runner-"));
    const objects = new Map<string, Uint8Array>();
    const writes: string[] = [];
    const reads: string[] = [];
    const start = (contents: string) =>
      new Miniflare({
        modules: [{ type: "ESModule", path: "qualified-runner.mjs", contents }],
        compatibilityDate: "2026-09-08",
        compatibilityFlags: ["nodejs_compat"],
        workerLoaders: { LOADER: {} },
        serviceBindings: {
          OBJECTS: async (request: Request) => {
            const url = new URL(request.url);
            const key = url.searchParams.get("key");
            assert.ok(key);
            if (url.pathname === "/put") {
              objects.set(key, new Uint8Array(await request.arrayBuffer()));
              return new Response(null, { status: 204 });
            }
            if (url.pathname === "/exists") return new Response(String(objects.has(key)));
            assert.equal(url.pathname, "/get");
            reads.push(key);
            const body = objects.get(key);
            return body === undefined
              ? new Response(null, { status: 404 })
              : new Response(new Uint8Array(body));
          },
          MARKER: async (request: Request) => {
            writes.push(await request.text());
            return new Response("recorded");
          },
        },
      });
    let host: InstanceType<typeof Miniflare> | undefined;
    try {
      const runtime = Schema.decodeUnknownSync(Schema.fromJsonString(PublishedAppFramework))(
        readFileSync(resolve(".upstream/packages/apps/dist/runtime.json"), "utf8"),
      );
      const a = await producer(runtime, "A"),
        b = await producer(runtime, "B"),
        c = await producer(runtime, "C"),
        d = await producer(runtime, "D");
      assert.notEqual(a.release.sha256, b.release.sha256);
      assert.equal(new Set([a, b, c, d].map(({ release }) => release.sha256)).size, 4);
      assert.equal(
        canonicalFrameworkReleases.some((entry) =>
          [a, b, c, d].some(({ release }) => entry.sha256 === release.sha256),
        ),
        false,
      );
      const releaseA = qualifiedFrameworkRegistry(
        canonicalFrameworkReleases,
        [],
        a.release,
        "a".repeat(40),
        a.artifacts,
      );
      const releaseB = qualifiedFrameworkRegistry(
        canonicalFrameworkReleases,
        [releaseA.qualification],
        b.release,
        "b".repeat(40),
        b.artifacts,
      );
      const bundle = await registryAuthoredBundle();
      const sourceA = await bundleRegistryRunner(directory, "A", releaseA.releases);
      const sourceB = await bundleRegistryRunner(directory, "B", releaseB.releases);
      const send = async (input: object) => {
        assert.ok(host);
        const response = await host.dispatchFetch("https://qualified-runner.test", {
          method: "POST",
          body: JSON.stringify(input),
        });
        assert.equal(response.status, 200);
        return response;
      };
      const retain = async (build: string, produced: typeof a) => {
        const value: unknown = await (
          await send({ retain: true, build, bundle, ...produced })
        ).json();
        const result = Schema.decodeUnknownSync(
          Schema.Struct({
            ok: Schema.Literal(true),
            value: Schema.Struct({ framework: RetainedFramework }),
          }),
        )(value);
        assert.deepEqual(result.value.framework.provenance, produced.release);
      };
      const invoke = (build: string, caller: string) =>
        runnerResult(
          Effect.tryPromise(async () =>
            (
              await send({
                invocation: JSON.stringify({
                  app: "qualified-registry-fixture",
                  build,
                  caller,
                  database: false,
                  command: { operation: "call", tool: "who", kind: "query", input: {} },
                  accounts: { app: {} },
                  headers: {},
                  elicitation: false,
                  workflowControls: false,
                }),
              })
            ).text(),
          ),
        );
      const called = async (build: string, caller: string) => {
        const value = await Effect.runPromise(invoke(build, caller));
        Schema.decodeUnknownSync(
          Schema.Struct({ ok: Schema.Literal(true), value: Schema.Literal(caller) }),
        )(value);
      };

      host = start(sourceA);
      await retain("bld_qualified_a", a);
      assert.deepEqual(writes, []);
      await host.dispose();
      host = start(sourceB);
      await called("bld_qualified_a", "A-cold-under-B");
      const coldReads = reads.length;
      assert.ok(coldReads >= 2, "A cold invocation must read its retained record and framework");
      await called("bld_qualified_a", "A-warm-under-B");
      assert.equal(reads.length, coldReads, "A warm invocation must reuse its admitted build");
      await retain("bld_qualified_b", b);
      await called("bld_qualified_b", "B-cold-under-B");
      assert.deepEqual(writes, ["A-cold-under-B", "A-warm-under-B", "B-cold-under-B"]);
      await host.dispose();
      host = undefined;

      const releaseC = qualifiedFrameworkRegistry(
        canonicalFrameworkReleases,
        [releaseA.qualification, releaseB.qualification],
        c.release,
        "c".repeat(40),
        c.artifacts,
      );
      const sourceC = await bundleRegistryRunner(directory, "C", releaseC.releases);
      host = start(sourceC);
      await retain("bld_failed_c", c);
      await called("bld_failed_c", "C-served-before-failed-activation");
      await host.dispose();
      host = undefined;

      // Ledger tests cover keeping C's qualification after failure; D must execute what C retained.
      const releaseD = qualifiedFrameworkRegistry(
        canonicalFrameworkReleases,
        [releaseA.qualification, releaseB.qualification, releaseC.qualification],
        d.release,
        "d".repeat(40),
        d.artifacts,
      );
      const sourceD = await bundleRegistryRunner(directory, "D", releaseD.releases);
      host = start(sourceD);
      for (const [build, label] of [
        ["bld_qualified_a", "A"],
        ["bld_failed_c", "failed-C"],
      ] as const) {
        const before = reads.length;
        await called(build, `${label}-cold-under-D`);
        assert.equal(
          reads.length,
          before + 2,
          `${label} must load its retained record and framework`,
        );
        await called(build, `${label}-warm-under-D`);
        assert.equal(reads.length, before + 2, `${label} must reuse its admitted build`);
      }
      const expectedWrites = [
        "A-cold-under-B",
        "A-warm-under-B",
        "B-cold-under-B",
        "C-served-before-failed-activation",
        "A-cold-under-D",
        "A-warm-under-D",
        "failed-C-cold-under-D",
        "failed-C-warm-under-D",
      ];
      assert.deepEqual(writes, expectedWrites);
      await host.dispose();
      host = undefined;

      const key = `frameworks/${a.release.version}-${a.release.sha256}.json`;
      const stored = objects.get(key);
      assert.ok(stored);
      const retained = Schema.decodeUnknownSync(Schema.fromJsonString(RetainedFramework))(
        new TextDecoder().decode(stored),
      );
      const module = Object.keys(retained.modules).sort()[0]!;
      objects.set(
        key,
        new TextEncoder().encode(
          JSON.stringify({
            ...retained,
            modules: {
              ...retained.modules,
              [module]: `${retained.modules[module]}\n// tampered\n`,
            },
          }),
        ),
      );
      host = start(sourceB);
      const refused = await Effect.runPromise(
        invoke("bld_qualified_a", "must-not-run").pipe(
          Effect.match({
            onSuccess: () => assert.fail("Tampered retained framework ran authored code"),
            onFailure: (error) => error,
          }),
        ),
      );
      assert.ok(Schema.is(FrameworkProvenanceRefused)(refused));
      assert.equal(refused.reason, "content-mismatch");
      assert.deepEqual(writes, expectedWrites);
    } finally {
      try {
        await host?.dispose();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  },
);
