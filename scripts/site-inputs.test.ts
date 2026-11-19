import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { hashDirectory } from "alchemy/Command/Memo";
import { Effect } from "effect";
import { siteInputs } from "../.upstream/apps/hosted/cloud/src/infrastructure/site-inputs.ts";
import { migrationInputs } from "../.upstream/apps/hosted/cloud/src/infrastructure/migration-inputs.ts";

/** Preparation rewrites these for every revision. No page or site script imports them. */
const perRevision = [
  "apps/hosted/cloud/src/implementation/production-ops-release.ts",
  "apps/hosted/server/src/implementation/catalog-app-release.ts",
  "apps/hosted/server/src/implementation/pool-worker-revision.ts",
];
const siteSources = [
  "apps/hosted/cloud/web/src/page.tsx",
  "apps/marketing/src/index.astro",
  "apps/docs/index.mdx",
  // The pool app's bundle version changes only with the pool app, and the site shows its pages.
  "apps/hosted/server/src/implementation/pool-app-source.ts",
  "bun.lock",
];

test("the site build's key follows the site's sources and not the revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "site-inputs-"));
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  // The installed build command's own key, on a tree shaped like the prepared one.
  const key = () =>
    Effect.runPromise(
      hashDirectory({ cwd: root, memo: siteInputs }).pipe(
        Effect.provideService(AlchemyContext, { dotAlchemy: ".alchemy", dev: false, adopt: false }),
        Effect.provide(NodeServices.layer),
      ),
    );
  try {
    for (const file of [...perRevision, ...siteSources, "ignored/output.txt", ".git/HEAD"])
      write(file, "before");
    write(".gitignore", "ignored/\n");
    const unchanged = await key();
    for (const file of [...perRevision, "ignored/output.txt"]) {
      write(file, "after");
      assert.equal(await key(), unchanged, `${file} must not change the site's key`);
      write(file, "before");
    }
    for (const file of siteSources) {
      write(file, "after");
      assert.notEqual(await key(), unchanged, `${file} must change the site's key`);
      write(file, "before");
    }
    assert.equal(await key(), unchanged);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the site and the migration leave out the same per-revision files", () => {
  // Both keys exist for the same reason. A new per-revision file has to be decided for both.
  const cloud = (file: string) => join("apps/hosted/cloud", file);
  const fromMigration = migrationInputs.exclude
    .map(cloud)
    .filter((file) => !file.endsWith("pool-app-source.ts"))
    .sort();
  assert.deepEqual(
    siteInputs.include
      .filter((pattern) => pattern.startsWith("!"))
      .map((p) => p.slice(1))
      .sort(),
    fromMigration,
  );
  assert.deepEqual(fromMigration, [...perRevision].sort());
});
