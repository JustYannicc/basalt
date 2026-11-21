import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const entry = fileURLToPath(new URL("./deploy.ts", import.meta.url));

// A plan that is the secret itself makes the entry's own failure text carry the secret, as a
// driver or API error might; the box keeps that text past the container only redacted.
test("a box release slot keeps the failure text, with the run's secret values taken out", async () => {
  const cwd = await mkdtemp(
    join(process.env.RUNNER_TEMP ?? join(homedir(), "Library", "Caches"), "entry-box-output-"),
  );
  const secret = "tok-7x9q";
  const kept = resolve(root, ".local/release/failure.txt");
  const before = await readFile(kept, "utf8").catch(() => undefined);
  try {
    await writeFile(join(cwd, "plan.json"), secret);
    const run = spawnSync(
      process.execPath,
      [entry, "serving", "--stage", "test-entry-paths", "--from", "plan.json", "--out", "out.json"],
      {
        cwd,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          BASALT_BOX_OUTPUT: join(cwd, "box"),
          TEST_API_TOKEN: secret,
        },
        timeout: 60_000,
      },
    );
    assert.notEqual(run.status, 0);
    const boxed = await readFile(join(cwd, "box", "release", "failure.txt"), "utf8");
    assert.match(boxed, /Release stopped in serving: SyntaxError/u);
    assert.match(boxed, /\[redacted\]/u);
    assert.doesNotMatch(boxed, new RegExp(secret, "u"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
    if (before === undefined) await rm(kept, { force: true });
    else await writeFile(kept, before);
  }
});
