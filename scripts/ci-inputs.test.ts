import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readDeclarations } from "./ci/declarations.ts";

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
