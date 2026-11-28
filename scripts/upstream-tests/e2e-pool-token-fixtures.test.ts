import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The tools service refuses a pool token for a pool its organization does not own, before the pool
// Worker runs any route. An e2e spec that mints its own pool token and drives the real pool Worker
// must therefore first give its organization the pool, through the shared owned-pool fixture. A
// made-up pool id gets the refusal, which a spec reads as a broken pool.

const e2e = resolve(dirname(fileURLToPath(import.meta.url)), "../../.upstream/e2e");
const tests = join(e2e, "tests");
const support = join(e2e, "support");

/** Specs allowed to mint a pool token for the real pool Worker without the fixture, and why. */
const unregistered: Readonly<Record<string, string>> = {};

const runtime = join(support, "pool-worker-runtime.ts");
const fixture = join(support, "owned-pool.ts");
/** A pool token made in place: the `sbp1` kind passed to a signer, or a token text starting with it. */
const mints = /\w+\(\s*["'`]sbp1["'`]|`sbp1\.|signPoolToken\(/;

/** The e2e files a file imports by relative path, followed through the support files. */
const imported = (file: string, seen = new Set<string>()) => {
  for (const [, target] of readFileSync(file, "utf8").matchAll(
    /from\s+["'](\.{1,2}\/[^"']+)["']/g,
  )) {
    const path = resolve(dirname(file), target!);
    if (!path.startsWith(e2e) || seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    if (path.startsWith(support)) imported(path, seen);
  }
  return seen;
};

const specs = readdirSync(tests)
  .filter((name) => name.endsWith(".spec.ts"))
  .map((name) => {
    const file = join(tests, name);
    const reached = imported(file);
    return {
      name,
      real: reached.has(runtime),
      registers: reached.has(fixture),
      mints: [file, ...reached].some((path) => mints.test(readFileSync(path, "utf8"))),
    };
  });

test("a spec that mints its own pool token for the real pool Worker gives its organization the pool first", () => {
  const minting = specs.filter((spec) => spec.real && spec.mints);
  // The guard sees the spec it was written for, so a broken match cannot pass it silently.
  assert.ok(
    minting.some((spec) => spec.name === "pool-empty-home.spec.ts"),
    minting.map((spec) => spec.name).join(", "),
  );
  const missing = minting
    .filter((spec) => !spec.registers && !(spec.name in unregistered))
    .map((spec) => relative(e2e, join(tests, spec.name)));
  assert.deepEqual(
    missing,
    [],
    "Use ownedPool from e2e/support/owned-pool.ts for the token's pool, or list the spec with a reason",
  );
});

test("every listed exception still mints a pool token for the real pool Worker", () => {
  for (const [name, reason] of Object.entries(unregistered)) {
    assert.ok(reason.trim().length > 0, name);
    const spec = specs.find((candidate) => candidate.name === name);
    assert.ok(spec?.real && spec.mints, `${name} no longer needs its exception`);
  }
});
