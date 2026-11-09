import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

for (const command of [process.execPath, "bun"])
  test(`native provider uses the exact declared migration verdict, then ordinary version admission after expansion (${command === "bun" ? "source" : "compiled"})`, (context) => {
    const scratch = mkdtempSync(join(tmpdir(), "class-provider-"));
    context.after(() => rmSync(scratch, { recursive: true, force: true }));
    const result = spawnSync(
      command,
      [fileURLToPath(new URL("./test/class-provider-proof.mjs", import.meta.url))],
      {
        env: {
          PATH: process.env.PATH,
          CI: "true",
          DO_NOT_TRACK: "1",
          ALCHEMY_HOME: join(scratch, "auth"),
          TMPDIR: scratch,
        },
        encoding: "utf8",
        timeout: 40_000,
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const line = result.stdout.split("\n").find((line) => line.startsWith("__CLASS_PROOF__"));
    assert.ok(line);
    const proof = JSON.parse(line.slice("__CLASS_PROOF__".length));
    assert.equal(proof.oldTag, "alchemy:v1");
    assert.equal(proof.newTag, "alchemy:v2");
    assert.deepEqual(proof.classNames, ["DriveObject"]);
    assert.ok(proof.reads > 0);
  });
