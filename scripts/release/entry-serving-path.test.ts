import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Imports nothing but the entry it runs, so it also runs, and fails, against an entry from before
// path flags were resolved. Both tests stay in this one file: they run one after the other, so
// neither restores the repo's private failure.txt under the other.
const root = fileURLToPath(new URL("../../", import.meta.url));
const entry = fileURLToPath(new URL("./deploy.ts", import.meta.url));

/** Runs `serving` from a fresh directory whose plan.json holds `plan`, keeping failure.txt as it was. */
async function serving(plan: string, env: Record<string, string>) {
  const cwd = await mkdtemp(
    join(process.env.RUNNER_TEMP ?? join(homedir(), "Library", "Caches"), "entry-paths-"),
  );
  // The failed run's private detail lands in the repo's own .local/release, as a release's does.
  const kept = resolve(root, ".local/release/failure.txt");
  const before = await readFile(kept, "utf8").catch(() => undefined);
  try {
    await writeFile(join(cwd, "plan.json"), plan);
    const run = spawnSync(
      process.execPath,
      [entry, "serving", "--stage", "test-entry-paths", "--from", "plan.json", "--out", "out.json"],
      { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env }, timeout: 60_000 },
    );
    const box = await readFile(join(cwd, "box", "release", "failure.txt"), "utf8").catch(
      () => undefined,
    );
    const boxMode = await stat(join(cwd, "box", "release", "failure.txt")).then(
      (entry) => entry.mode & 0o777,
      () => undefined,
    );
    return { status: run.status, output: `${run.stdout}\n${run.stderr}`, cwd, box, boxMode };
  } finally {
    await rm(cwd, { recursive: true, force: true });
    if (before === undefined) await rm(kept, { force: true });
    else await writeFile(kept, before);
  }
}

// The release runs `deploy.ts serving --from .local/release/plan.json`; the entry moves into the cloud
// app before it reads the file. A file that is not JSON shows which one it read: the one in the
// starting directory stops on SyntaxError, a path inside the cloud app on a missing file.
test("serving reads a relative --from in the starting directory, before anything goes out", async () => {
  const run = await serving("not json", {});
  assert.notEqual(run.status, 0);
  assert.match(run.output, /Release stopped in serving: SyntaxError/u);
  assert.doesNotMatch(run.output, /Outgoing requests/u);
});

// A plan that is the secret itself makes the entry's own failure text carry the secret, as a
// driver or API error might; the box keeps that text past the container only redacted.
test("a box release slot keeps the failure text owner-only, with the run's secret values taken out", async () => {
  const secret = "tok-7x9q";
  const run = await serving(secret, { BASALT_BOX_OUTPUT: "box", TEST_API_TOKEN: secret });
  assert.notEqual(run.status, 0);
  assert.match(run.box ?? "", /Release stopped in serving: SyntaxError/u);
  assert.match(run.box ?? "", /\[redacted\]/u);
  assert.doesNotMatch(run.box ?? "", new RegExp(secret, "u"));
  assert.equal(run.boxMode, 0o600);
});
