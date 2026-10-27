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

test("stack provisioning jobs run Node scripts without shell quoting", () => {
  // Alchemy's Command.Exec splits on whitespace without a shell, so quotes reach node as part of the path.
  for (const file of ["../alchemy.run.ts", "../src/pool/database.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const jobs = source.match(/Command\.Exec\(/g)?.length ?? 0;
    const safe = [...source.matchAll(/command: `node \$\{basename\((\w+)\)\}`,\s*cwd: dirname\((\w+)\)/g)];
    assert.ok(jobs > 0, file);
    assert.equal(safe.length, jobs, `${file}: every provisioning job runs its script by name from its own directory`);
    for (const [, name, directory] of safe) assert.equal(name, directory, file);
    for (const [, command] of source.matchAll(/command:\s*([^\n]+)/g))
      assert.doesNotMatch(command!.replace(/^`|`,?$/g, ""), /['"&|;=]/, `${file}: ${command}`);
  }
});

test("the pool database grants its owner to the runtime role's Postgres login, not its display name", () => {
  const source = readFileSync(new URL("../src/pool/database.ts", import.meta.url), "utf8");
  assert.match(source, /POOL_DATABASE_RUNTIME_ROLE: runtime\.username,/);
  assert.doesNotMatch(source, /POOL_DATABASE_RUNTIME_ROLE: runtime\.name/);
});
