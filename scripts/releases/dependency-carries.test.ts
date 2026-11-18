import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  carryErrors,
  dependencyCarries,
  patchedPackages,
  unlinked,
  type Registry,
} from "./dependency-carries.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const registryPath = "scripts/releases/dependency-carries.json";
const registry: Registry = JSON.parse(
  readFileSync(new URL("./dependency-carries.json", import.meta.url), "utf8"),
);
const git = (args: string[]) =>
  spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });

// The unlinked set may only shrink: compare it with the registry where this branch left main.
function baseUnlinked(): Set<string> | null {
  const base = git(["merge-base", "HEAD", "origin/main"]);
  if (base.status !== 0) return null;
  const shown = git(["show", `${base.stdout.trim()}:${registryPath}`]);
  return shown.status === 0 ? unlinked(JSON.parse(shown.stdout)) : null;
}

test("every carry that patches a dependency is recorded with its upstream issue and owner", () => {
  const allowed = baseUnlinked() ?? unlinked(registry);
  assert.deepEqual(carryErrors(dependencyCarries(root), registry, allowed), []);
});

test("the unlinked carries only shrink against main", () => {
  const before = baseUnlinked();
  if (!before) return; // The registry starts with this change.
  for (const stem of unlinked(registry)) assert.ok(before.has(stem), `${stem} became unlinked`);
});

test("would have stopped the 6 Nov Alchemy upload hook until it named an upstream issue", () => {
  // 0f3f01cc9 started the custom release layer with carry 0370, an Alchemy fork nobody upstream knew of.
  const patch = execFileSync(
    "git",
    ["show", "0f3f01cc9:patches/0370-alchemy-worker-upload-hook.patch"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 << 20,
    },
  );
  assert.deepEqual(patchedPackages(patch), ["alchemy"]);
  const added = new Map([["0370-alchemy-worker-upload-hook", ["alchemy"]]]);
  assert.match(
    carryErrors(added, { carries: {} }, new Set())[0]!,
    /0370-alchemy-worker-upload-hook patches alchemy/,
  );
  const entry = (upstream: string | null) => ({
    carries: {
      "0370-alchemy-worker-upload-hook": { packages: ["alchemy"], upstream, owner: "release" },
    },
  });
  assert.match(carryErrors(added, entry(null), new Set())[0]!, /name its upstream issue/);
  assert.match(carryErrors(added, entry("x"), new Set())[0]!, /name its upstream issue/);
  assert.match(
    carryErrors(added, entry("https://github.com/JustYannicc/basalt/issues/1"), new Set())[0]!,
    /outside this repository/,
  );
  assert.deepEqual(
    carryErrors(added, entry("https://github.com/alchemy-run/alchemy/issues/1"), new Set()),
    [],
  );
});

test("a removed carry must leave the registry", () => {
  assert.match(
    carryErrors(new Map(), registry, unlinked(registry))[0]!,
    /no longer patches a dependency/,
  );
});
