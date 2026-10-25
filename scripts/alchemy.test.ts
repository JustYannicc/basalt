import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { alchemyArgs } from "./alchemy.ts";

test("Bun runs the workspace's Alchemy bin with every argument and returns its exit code", () => {
  const root = mkdtempSync(join(tmpdir(), "basalt-alchemy-"));
  try {
    const cloud = join(root, "apps", "cloud");
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    mkdirSync(cloud, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", private: true, workspaces: ["apps/*"] }));
    writeFileSync(join(cloud, "package.json"), JSON.stringify({ name: "cloud", private: true }));
    const record = join(root, "argv.json");
    const bin = join(root, "node_modules", ".bin", "alchemy");
    writeFileSync(bin, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));
process.exit(Number(process.env.FAKE_ALCHEMY_EXIT));
`);
    chmodSync(bin, 0o755);
    const args = ["deploy", "../../../../alchemy.run.ts", "--stage", "production", "--yes"];
    for (const exitCode of [0, 3]) {
      const result = spawnSync("bun", alchemyArgs(...args), {
        cwd: cloud,
        env: { ...process.env, FAKE_ALCHEMY_EXIT: String(exitCode) },
        encoding: "utf8",
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, exitCode);
      assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), args);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the production entrypoint invokes Alchemy only through alchemyArgs", () => {
  const source = readFileSync(new URL("./deploy.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /"exec"/);
  assert.equal(source.match(/alchemyArgs\("deploy"/g)?.length, 2);
});
