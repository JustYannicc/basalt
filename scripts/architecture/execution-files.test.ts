import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { expect, test } from "vitest";
import { executionFiles } from "./execution-files.ts";

test("build, deployment and runtime sources share one ownership boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "execution-files-"));
  try {
    const selected = ["alchemy.run.ts", "brand.ts", "scripts/ensure-artifacts.ts", "scripts/new-build.py", "containers/pool/fetch_releases.py", "src/router.ts", "custom/app.py"];
    const excluded = [".upstream/stack.ts", "scripts/architecture/check.ts", "scripts/pool-tests/fixture.ts", "scripts/build-tests/brand.test.ts", "scripts/check.test.ts", "containers/pool/test_bootstrap.py"];
    for (const file of [...selected, ...excluded]) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), ""); }
    expect(executionFiles(root, [{ code: "custom" }, { code: ".upstream" }]).map(file => relative(root, file)).sort()).toEqual(selected.sort());
  } finally { rmSync(root, { recursive: true, force: true }); }
});
