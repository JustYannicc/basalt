import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The tools service refuses a pool token for a pool its organization does not own, before the pool
// Worker runs any route. An e2e scenario that made up a pool id and signed its own token for it
// would read that refusal as a broken pool. So e2e code that sends the pool Worker a pool token the
// product did not issue takes the pool and the token from the shared owned-pool fixture, which
// gives the organization the pool first: no other e2e file may name the token's kind, unless it is
// listed here with the reason it needs to. Tokens the product issues (manager tokens) name no kind
// here and need no entry.

const e2e = resolve(dirname(fileURLToPath(import.meta.url)), "../../.upstream/e2e");

/** The e2e files that may name the pool token's kind, and why. */
const allowed: Readonly<Record<string, string>> = {
  "support/owned-pool.ts":
    "signs the owner token for the pool it gives the scenario's organization",
  "support/retired-pool-token-command.ts":
    "builds retired tokens for the operator's retirement command; they are saved as accounts and never reach the pool Worker",
  "support/account-reset-pool.ts":
    "verifies the tokens a stand-in pool backend receives; it mints none and runs no ownership check",
};

const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : [];
  });

const naming = sources(e2e)
  .filter((path) => readFileSync(path, "utf8").includes("sbp1"))
  .map((path) => relative(e2e, path));

test("e2e pool tokens the product did not issue come from the owned-pool fixture, or say why not", () => {
  // The fixture itself names the kind, so a broken scan cannot pass silently.
  assert.ok(naming.includes("support/owned-pool.ts"), naming.join(", "));
  assert.deepEqual(
    naming.filter((path) => !(path in allowed)),
    [],
    "Take the scenario's pool and its token from ownedPool in e2e/support/owned-pool.ts, or list the file with a reason",
  );
});

test("every listed file still names the pool token's kind and says why", () => {
  for (const [path, reason] of Object.entries(allowed)) {
    assert.ok(reason.trim().length > 0, path);
    assert.ok(naming.includes(path), `${path} no longer needs its entry`);
  }
});

// The retirement fixture's tokens are saved as accounts and only checked for leaks; none is sent
// to the pool Worker, so they stay with that fixture.
test("the retired-token builder stays with the retirement fixture, which saves its tokens as accounts", () => {
  const users = sources(e2e)
    .filter((path) => readFileSync(path, "utf8").includes("retirementToken"))
    .map((path) => relative(e2e, path))
    .sort();
  assert.deepEqual(users, [
    "support/retired-pool-token-command.ts",
    "support/retired-pool-token-fixture.ts",
  ]);
});
