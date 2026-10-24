import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { hashDirectory } from "alchemy/Command/Memo";
import { Effect } from "effect";

const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
const cloud = join(upstream, "apps/hosted/cloud");

const seed = (content: string) => {
  const files = [{ path: "index.ts", content }];
  const version = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return {
    name: `pool-app-${version}.json`,
    bytes: JSON.stringify(files),
  };
};

test("site build copies the current pool seed into the hashed public asset path", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "basalt-pool-site-assets-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  const fixtureCloud = join(fixtureRoot, "apps/hosted/cloud");
  const script = join(fixtureCloud, "scripts/build-site.ts");
  const pool = join(fixtureCloud, ".generated/pool-app");
  const output = join(fixtureCloud, ".generated/site");
  const sources = [
    [join(cloud, "scripts/build-site.ts"), script],
    [
      join(cloud, "src/implementation/site-redirects.ts"),
      join(fixtureCloud, "src/implementation/site-redirects.ts"),
    ],
    [
      join(cloud, "src/contracts/site-redirects.ts"),
      join(fixtureCloud, "src/contracts/site-redirects.ts"),
    ],
    [
      join(cloud, "src/contracts/retained-assets.ts"),
      join(fixtureCloud, "src/contracts/retained-assets.ts"),
    ],
    [join(cloud, "package.json"), join(fixtureCloud, "package.json")],
  ] as const;
  for (const [source, destination] of sources) {
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
  }
  await symlink(join(cloud, "node_modules"), join(fixtureCloud, "node_modules"), "dir");

  const marketing = join(fixtureRoot, "apps/marketing/dist");
  const dashboard = join(fixtureCloud, "web/dist/client");
  const docs = join(fixtureRoot, "apps/docs/dist");
  await Promise.all(
    [marketing, dashboard, docs, pool, output].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  await Promise.all([
    writeFile(join(marketing, "index.html"), "marketing"),
    writeFile(join(dashboard, "dashboard.js"), "dashboard"),
    writeFile(join(docs, "index.html"), "docs"),
  ]);

  const stale = join(output, "stale-before-build.txt");
  await writeFile(stale, "stale");
  const first = seed("first pool source");
  await writeFile(join(pool, first.name), first.bytes);
  runSiteBuild(fixtureRoot, script);

  const firstAsset = join(output, "_basalt", first.name);
  assert.equal(await readFile(firstAsset, "utf8"), first.bytes);
  await assert.rejects(lstat(stale), { code: "ENOENT" });
  const firstHash = await siteOutputHash(output);

  await rm(join(pool, first.name));
  const second = seed("updated pool source");
  await writeFile(join(pool, second.name), second.bytes);
  runSiteBuild(fixtureRoot, script);

  const secondAsset = join(output, "_basalt", second.name);
  assert.equal(await readFile(secondAsset, "utf8"), second.bytes);
  await assert.rejects(lstat(firstAsset), { code: "ENOENT" });
  assert.notEqual(await siteOutputHash(output), firstHash);
});

function runSiteBuild(fixtureRoot: string, script: string) {
  const result = spawnSync(process.execPath, [script], {
    cwd: fixtureRoot,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

const siteOutputHash = (output: string) =>
  Effect.runPromise(
    hashDirectory({ cwd: output, memo: { exclude: [], lockfile: false } }).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
