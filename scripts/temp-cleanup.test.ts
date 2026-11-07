import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

for (const failure of [false, true])
  test(`scale fixtures remove temporary directories after ${failure ? "failure" : "success"}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "basalt-temp-cleanup-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const scratch = join(root, "tmp");
    mkdirSync(scratch);
    const inject = join(root, "fail.mjs");
    writeFileSync(
      inject,
      `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; const write = fs.writeFileSync; fs.writeFileSync = (path, ...args) => { if (String(path).endsWith('/candidate.json')) throw Error('Fixture failure'); return write(path, ...args); }; syncBuiltinESMExports();`,
    );
    const result = spawnSync(
      process.execPath,
      [
        ...(failure ? ["--import", inject] : []),
        "--test",
        "e2e/scale-verdict.test.mjs",
        ...(failure ? [] : ["e2e/scale-test.test.mjs"]),
      ],
      {
        encoding: "utf8",
        env: {
          PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
          TMPDIR: scratch,
          TMP: scratch,
          TEMP: scratch,
        },
      },
    );
    assert.equal(result.status === 0, !failure, result.stderr + result.stdout.slice(-1500));
    assert.deepEqual(
      readdirSync(scratch),
      [],
      "completed tests must remove their temporary fixture data",
    );
  });
