import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { frameworkIdentity } from "../../.upstream/packages/sdk/src/implementation/framework-identity.ts";
import { qualifiedFrameworkRegistry } from "../deploy-safety/framework-registry.ts";
import { buildRegistryHost } from "./framework-registry-host-fixture.ts";

async function producer(name: string) {
  const version = "synthetic-cumulative-release";
  const modules = { "node_modules/apps/index.js": `export const framework = '${name}';` };
  const identity = await Effect.runPromise(frameworkIdentity({ version, modules }));
  return {
    modules,
    artifacts: { runtimeJsonSha256: name.repeat(64), frameworkJsonSha256: name.repeat(64) },
    release: {
      ...identity,
      protocol: 40,
      browserSha256: name.repeat(64),
      source: { origin: "basalt" as const, revision: `source-${name}`, sha256: name.repeat(64) },
    },
  };
}

test("fresh default hosts retain A through B and a failed C activation through successful D offline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "basalt-qualified-hosts-"));
  const store = join(directory, "objects");
  const run = (host: string, input: object) =>
    JSON.parse(
      execFileSync(process.execPath, [host], {
        input: JSON.stringify({ store, ...input }),
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: directory },
      }),
    ) as {
      ok: boolean;
      value?: { framework: unknown; format: number };
      error?: { reason: string };
    };
  try {
    const a = await producer("a"),
      b = await producer("b"),
      c = await producer("c"),
      d = await producer("d");
    const releaseA = qualifiedFrameworkRegistry([], [], a.release, "a".repeat(40), a.artifacts);
    const hostA = await buildRegistryHost(directory, "a", releaseA.releases);
    assert.equal(
      run(hostA, { action: "retain", id: "bld_release_a", ...a, release: a.release }).ok,
      true,
    );
    const releaseB = qualifiedFrameworkRegistry(
      [],
      [releaseA.qualification],
      b.release,
      "b".repeat(40),
      b.artifacts,
    );
    const hostB = await buildRegistryHost(directory, "b", releaseB.releases);
    for (const [id, format] of [
      ["bld_release_a", 2],
      ["bld_release_a_inlined", 1],
    ] as const) {
      const loaded = run(hostB, { id });
      assert.equal(loaded.ok, true);
      assert.equal(loaded.value?.format, format);
      assert.deepEqual(loaded.value?.framework, a.release);
    }
    assert.equal(
      run(hostB, { action: "retain", id: "bld_release_b", ...b, release: b.release }).ok,
      true,
    );
    assert.equal(run(hostB, { id: "bld_release_b" }).ok, true);
    assert.equal(
      run(hostB, { id: "bld_release_a", forged: true }).error?.reason,
      "conflicting-lineage",
    );
    assert.equal(
      run(hostB, { action: "retain", id: "bld_unlisted", ...c, release: c.release }).error?.reason,
      "content-mismatch",
    );

    // A failing activation can briefly serve C. Its qualification remains an input to D.
    const releaseC = qualifiedFrameworkRegistry(
      [],
      [releaseA.qualification, releaseB.qualification],
      c.release,
      "c".repeat(40),
      c.artifacts,
    );
    const hostC = await buildRegistryHost(directory, "c", releaseC.releases);
    assert.equal(
      run(hostC, { action: "retain", id: "bld_failed_c", ...c, release: c.release }).ok,
      true,
    );
    const releaseD = qualifiedFrameworkRegistry(
      [],
      [releaseA.qualification, releaseB.qualification, releaseC.qualification],
      d.release,
      "d".repeat(40),
      d.artifacts,
    );
    const hostD = await buildRegistryHost(directory, "d", releaseD.releases);
    for (const id of [
      "bld_release_a",
      "bld_release_a_inlined",
      "bld_release_b",
      "bld_failed_c",
      "bld_failed_c_inlined",
    ])
      assert.equal(run(hostD, { id }).ok, true, id);
    assert.deepEqual(run(hostD, { id: "bld_failed_c" }).value?.framework, c.release);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
