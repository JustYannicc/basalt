import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  carryErrors,
  dependencyCarries,
  patchedPackages,
  type Registry,
} from "./dependency-carries.ts";

const root = new URL("../..", import.meta.url).pathname;
const registry: Registry = JSON.parse(
  readFileSync(new URL("./dependency-carries.json", import.meta.url), "utf8"),
);
// Dependency carries that had no upstream issue or owner on 18 Nov. Remove a line when its entry
// gets both or its carry goes; never add one.
const unlinkedAllowed = new Set([
  "0003-eu-durable-objects",
  "0116-compiler-request-ownership",
  "0138-auth-security-hardening",
  "0170-container-image-drift",
  "0229-independent-compiler-sessions",
  "0309-normalized-container-resources",
  "0311-container-publication-outputs",
  "0329-declared-container-instances",
  "0370-alchemy-worker-upload-hook",
  "0381-alchemy-patch-source-map",
  "0386-alchemy-container-publication-hook",
  "0404-alchemy-read-only-state",
  "0423-alchemy-script-settings-projection",
  "0433-alchemy-state-credentials-export",
  "0535-oauth-refresh-transient",
  "0542-compiler-package-imports",
  "0673-alchemy-asset-session-renewal",
  "0677-alchemy-lazy-entrypoint",
]);

test("every carry that patches a dependency is recorded with its upstream issue and owner", () => {
  assert.deepEqual(carryErrors(dependencyCarries(root), registry, unlinkedAllowed), []);
});

test("the unlinked list only names carries still recorded without a link", () => {
  for (const stem of unlinkedAllowed) {
    const entry = registry.carries[stem];
    assert.ok(entry && !(entry.upstream && entry.owner), `${stem}: remove it from unlinkedAllowed`);
  }
});

test(
  "would have stopped the 6 Nov Alchemy upload hook until it named an upstream issue",
  { skip: present("0f3f01cc9") ? false : "needs the full repository history" },
  () => {
    // 0f3f01cc9 started the custom release layer with carry 0370, an Alchemy fork nobody upstream knew of.
    const patch = execFileSync(
      "git",
      ["show", "0f3f01cc9:patches/0370-alchemy-worker-upload-hook.patch"],
      { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 },
    );
    assert.deepEqual(patchedPackages(patch), ["alchemy"]);
    const added = new Map([["0370-alchemy-worker-upload-hook", ["alchemy"]]]);
    assert.match(
      carryErrors(added, { carries: {} }, new Set())[0]!,
      /0370-alchemy-worker-upload-hook patches alchemy/,
    );
    const unlinked: Registry = {
      carries: {
        "0370-alchemy-worker-upload-hook": { packages: ["alchemy"], upstream: null, owner: null },
      },
    };
    assert.match(carryErrors(added, unlinked, new Set())[0]!, /name its upstream issue/);
    const linked: Registry = {
      carries: {
        "0370-alchemy-worker-upload-hook": {
          packages: ["alchemy"],
          upstream: "https://github.com/alchemy-run/alchemy/issues/1",
          owner: "release",
        },
      },
    };
    assert.deepEqual(carryErrors(added, linked, new Set()), []);
  },
);

test("a removed carry must leave the registry", () => {
  assert.match(
    carryErrors(new Map(), registry, unlinkedAllowed)[0]!,
    /no longer patches a dependency/,
  );
});

function present(commit: string) {
  return spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: root }).status === 0;
}
