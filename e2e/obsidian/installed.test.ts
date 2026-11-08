import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The installed SDK fixture uses its own exact-optional-property compiler contract.
test("installed Obsidian HTTP, MCP, approvals and native automation", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const generated = join(root, ".generated");
  await mkdir(generated, { recursive: true });
  const directory = await mkdtemp(join(generated, "obsidian-proof-"));
  try {
    const entry = join(directory, "installed.test.ts");
    const config = join(directory, "tsconfig.json");
    await writeFile(entry, await readFile(new URL("./installed.fixture.ts.txt", import.meta.url)));
    await writeFile(
      config,
      JSON.stringify({
        extends: join(root, ".upstream/tsconfig.json"),
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          resolveJsonModule: true,
          typeRoots: [join(root, ".upstream/node_modules/@types")],
        },
        files: [entry],
        include: [],
        exclude: [],
      }),
    );
    execFileSync(join(root, ".upstream/node_modules/.bin/tsc-rs"), ["--noEmit", "-p", config], {
      cwd: root,
      stdio: "inherit",
      timeout: 60000,
    });
    execFileSync(process.execPath, [entry], {
      cwd: join(root, ".upstream"),
      stdio: "inherit",
      timeout: 150000,
    });
    const receipt = JSON.parse(await readFile(join(directory, "receipt.json"), "utf8"));
    assert.deepEqual(receipt, {
      installedApp: true,
      publicHttp: true,
      publicMcp: true,
      approvalEnforced: true,
      batchApprovalEnforced: true,
      quotaResourcePreserved: true,
      nativePluginImportedAttachment: true,
      nativeAutomationWrote: true,
      isolatedAppDrives: true,
      devices: 0,
    });
    console.log(JSON.stringify({ cloudDriveProof: receipt }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
