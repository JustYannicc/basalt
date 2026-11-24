import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { migrationInputs } from "../.upstream/apps/hosted/cloud/src/infrastructure/migration-inputs.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
// The key's patterns are relative to the cloud app; files are named from the prepared tree's root.
const prepared = (pattern: string) => posix.normalize(posix.join("apps/hosted/cloud", pattern));
const matcher = (pattern: string) =>
  new RegExp(
    `^${prepared(pattern)
      .split("**")
      .map((part) =>
        part
          .split("*")
          .map((text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]*"),
      )
      .join(".*")}$`,
  );
const include = migrationInputs.include.map(matcher);
const exclude = migrationInputs.exclude.map(prepared);
const inKey = (file: string) =>
  include.some((pattern) => pattern.test(file)) && !exclude.includes(file);

/** Copies of this repository's own sources. They change only when those sources change. */
const copiedSources = [
  "apps/hosted/server/src/implementation/cloudflare-scopes.ts",
  "apps/hosted/server/src/implementation/native-contract.ts",
  "apps/hosted/server/src/implementation/pool-access-contract.ts",
  "apps/hosted/server/src/implementation/pool-account-acquisition-contract.ts",
  "apps/hosted/server/src/implementation/pool-provider-capabilities.ts",
  "apps/hosted/server/src/implementation/pool-provider-definitions.ts",
  "apps/hosted/server/src/implementation/pool-token.ts",
  "packages/sdk/src/implementation/oauth-client-id.ts",
];

test("every file preparation writes into the migration's key is named", () => {
  // In the prepared tree an untracked file comes from a carry or from preparation.
  const untracked = execFileSync(
    "git",
    [
      "ls-files",
      "--others",
      "--",
      "apps/hosted/cloud/src",
      "apps/hosted/server/src",
      "apps/marketing/src",
      ":(glob)packages/*/src/**",
    ],
    { cwd: `${root}.upstream`, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\n")
    .filter(Boolean);
  const carried = new Set<string>();
  for (const name of readdirSync(`${root}patches`))
    if (name.endsWith(".patch"))
      // A text addition names /dev/null; a binary one has only its diff header's new file mode.
      for (const match of readFileSync(`${root}patches/${name}`, "utf8").matchAll(
        /^--- \/dev\/null\n\+\+\+ b\/(.+)$|^diff --git a\/\S+ b\/(\S+)\nnew file mode /gm,
      ))
        carried.add((match[1] ?? match[2])!);
  // A file rewritten for every revision would run the migration, and everything waiting on it,
  // on every release. Exclude it from the key if the migration does not import it.
  assert.deepEqual(
    untracked.filter((file) => inKey(file) && !carried.has(file)).sort(),
    copiedSources,
  );
  for (const file of exclude) assert.ok(untracked.includes(file), `${file} is no longer written`);
});
