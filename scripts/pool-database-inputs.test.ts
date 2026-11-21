import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { hashDirectory } from "alchemy/Command/Memo";
import { Effect } from "effect";
import {
  poolDatabaseCommandSources,
  poolDatabaseInputs,
} from "../src/pool/model-history/sources.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const lockfile = "../.upstream/bun.lock";

test("the pool database command's key is every file the command runs", () => {
  // Packages are covered by the lockfile, which the key also holds. Everything else the command
  // loads is a relative import, followed here from its entry.
  const seen = new Set<string>();
  const pending = [resolve(root, "scripts/ensure-pool-database.ts")];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(
      /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/gu,
    )) {
      if (!/^\.{1,2}\//u.test(specifier!)) continue;
      const target = resolve(dirname(file), specifier!);
      assert.ok(existsSync(target), `${relative(root, file)} imports ${specifier}`);
      pending.push(target);
    }
  }
  // A file missing from the key would let a release skip the command although its statements
  // changed. A file that is listed but no longer run would re-run it for nothing.
  assert.deepEqual(
    [...seen].map((file) => relative(root, file).replaceAll("\\", "/")).sort(),
    [...poolDatabaseCommandSources].sort(),
  );
});

test("the key names those files from the directory the command runs in", () => {
  // The lockfile is the one entry that is not a source: it pins the database driver.
  assert.deepEqual(
    poolDatabaseInputs.include
      .filter((path) => path !== lockfile)
      .map((path) => relative(root, resolve(root, "scripts", path)))
      .sort(),
    [...poolDatabaseCommandSources].sort(),
  );
  assert.ok(poolDatabaseInputs.include.includes(lockfile));
});

test("the key follows the lockfile that pins the database driver", async () => {
  // The installed command's own key, on a scratch tree laid out like this repository.
  const tree = mkdtempSync(join(tmpdir(), "pool-database-inputs-"));
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(tree, file)), { recursive: true });
    writeFileSync(join(tree, file), text);
  };
  const key = () =>
    Effect.runPromise(
      hashDirectory({ cwd: join(tree, "scripts"), memo: poolDatabaseInputs }).pipe(
        Effect.provideService(AlchemyContext, { dotAlchemy: ".alchemy", dev: false, adopt: false }),
        Effect.provide(NodeServices.layer),
      ),
    );
  try {
    for (const file of [...poolDatabaseCommandSources, ".upstream/bun.lock", "unrelated.ts"])
      write(file, "before");
    const unchanged = await key();
    for (const file of [".upstream/bun.lock", "brand.ts", "scripts/ensure-pool-database.ts"]) {
      write(file, "after");
      assert.notEqual(await key(), unchanged, `${file} must change the command's key`);
      write(file, "before");
    }
    write("unrelated.ts", "after");
    assert.equal(await key(), unchanged);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});
