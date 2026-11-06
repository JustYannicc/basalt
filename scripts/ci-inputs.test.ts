import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readDeclarations } from "./ci/declarations.ts";
import { carryTargets, frozenInputMatcher } from "./ci/inputs.ts";
import { snapshotUpstreamInputs } from "./ci/snapshot-upstream-inputs.ts";

test("supported unified carries retain added, changed and deleted source targets", () => {
  const patch = readFileSync(
    new URL("../patches/0123-oauth-granted-scopes.patch", import.meta.url),
    "utf8",
  );
  assert.ok(carryTargets(patch).includes(".upstream/packages/sdk/src/contracts/oauth-scopes.ts"));
  assert.ok(
    frozenInputMatcher(new URL("../", import.meta.url).pathname)(
      ".upstream/packages/sdk/src/contracts/oauth-scopes.ts",
    ),
  );
  assert.deepEqual(
    carryTargets(
      [
        "--- /dev/null",
        "+++ b/added.ts",
        "@@ -0,0 +1 @@",
        "+added",
        "--- a/changed.ts",
        "+++ b/changed.ts",
        "@@ -1 +1 @@",
        "-before",
        "+after",
        "--- a/deleted.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-deleted",
        "",
      ].join("\n"),
    ),
    [".upstream/added.ts", ".upstream/changed.ts", ".upstream/deleted.ts"],
  );
  for (const patch of ["--- /dev/null\n+++ b/../outside.ts\n@@ -0,0 +1 @@\n+outside\n"])
    assert.throws(() => carryTargets(patch), /Unsupported carry target/);
});

test("declaration inputs match committed root source, pinned source or frozen carry targets", () => {
  const root = mkdtempSync(join(tmpdir(), "basalt-frozen-inputs-"));
  const write = (file: string, value: string | object) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof value === "string" ? value : JSON.stringify(value));
  };
  const pin = "a".repeat(40);
  const declaration = {
    scenarios: {
      hostedRoutes: {
        title: "Hosted Routes installs the Maps source",
        targets: {
          cloud: { status: "scheduled" },
          local: { status: "not-applicable", reason: "Hosted route" },
          "self-host": { status: "not-applicable", reason: "Hosted route" },
        },
      },
    },
    runs: { hostedRoutes: ["declared:cloud"] },
    inputs: [
      "src/catalog/google-maps/**",
      ".upstream/packages/apps/src/runtime.ts",
      ".upstream/packages/sdk/carried.ts",
      ".upstream/packages/sdk/unified-added.ts",
    ],
  };
  try {
    write("src/catalog/google-maps/hosted-routes.ts", "export const routes = true;\n");
    write("upstream.json", { commit: pin });
    write("scripts/ci/upstream-files.json", { pin, files: ["packages/apps/src/runtime.ts"] });
    write("scripts/ci/inherited-tests.json", { manualTargets: {} });
    write("scripts/ci/e2e-groups.json", {
      "declared:cloud": { job: "declared-cloud", target: "cloud", mode: "managed", matrix: true },
    });
    write(
      "patches/0001-example.patch",
      "diff --git a/packages/sdk/carried.ts b/packages/sdk/carried.ts\n",
    );
    write(
      "patches/0002-unified.patch",
      "--- /dev/null\n+++ b/packages/sdk/unified-added.ts\n@@ -0,0 +1 @@\n+export const added = true;\n",
    );
    write("e2e/plans/hosted-routes.spec.ts.json", declaration);
    for (const args of [
      ["init", "-q"],
      ["add", "."],
      [
        "-c",
        "user.name=CI fixture",
        "-c",
        "user.email=ci@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "Frozen source",
      ],
    ])
      execFileSync("git", args, { cwd: root, stdio: "pipe" });
    assert.deepEqual(
      readDeclarations(root).files["hosted-routes.spec.ts"]!.inputs,
      declaration.inputs,
    );

    // An untracked file with the typo must not make a dead declaration look valid.
    write("src/catalog/google-map/hosted-routes.ts", "export const typo = true;\n");
    write("e2e/plans/hosted-routes.spec.ts.json", {
      ...declaration,
      inputs: ["src/catalog/google-map/**"],
    });
    assert.throws(() => readDeclarations(root), /hosted-routes.*no frozen source.*google-map/);

    write(".upstream/packages/sdk/not-carried.ts", "export const stray = true;\n");
    write("e2e/plans/hosted-routes.spec.ts.json", {
      ...declaration,
      inputs: [".upstream/packages/sdk/not-carried.ts"],
    });
    assert.throws(() => readDeclarations(root), /no frozen source.*not-carried/);

    write("e2e/plans/hosted-routes.spec.ts.json", declaration);
    write("scripts/ci/upstream-files.json", { pin: "b".repeat(40), files: [] });
    assert.throws(() => readDeclarations(root), /stale frozen upstream input inventory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the regeneration helper snapshots the pinned Git tree without stray prepared source", () => {
  const root = mkdtempSync(join(tmpdir(), "basalt-pin-inputs-"));
  const upstream = join(root, ".upstream");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: upstream,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    mkdirSync(join(upstream, "packages/apps"), { recursive: true });
    mkdirSync(join(root, "scripts/ci"), { recursive: true });
    writeFileSync(join(upstream, "packages/apps/source.ts"), "export const source = true;\n");
    git("init", "-q");
    git("add", ".");
    git(
      "-c",
      "user.name=CI fixture",
      "-c",
      "user.email=ci@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "Pinned source",
    );
    const pin = git("rev-parse", "HEAD");
    writeFileSync(join(root, "upstream.json"), JSON.stringify({ commit: pin }));
    writeFileSync(join(upstream, "packages/apps/stray.ts"), "export const stray = true;\n");
    assert.equal(snapshotUpstreamInputs(root), 1);
    const path = join(root, "scripts/ci/upstream-files.json");
    const snapshot = readFileSync(path, "utf8");
    assert.deepEqual(JSON.parse(snapshot), { pin, files: ["packages/apps/source.ts"] });
    snapshotUpstreamInputs(root);
    assert.equal(readFileSync(path, "utf8"), snapshot);
    writeFileSync(join(root, "upstream.json"), JSON.stringify({ commit: "main" }));
    assert.throws(() => snapshotUpstreamInputs(root), /immutable upstream commit/);
    assert.equal(readFileSync(path, "utf8"), snapshot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
