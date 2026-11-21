import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolvePathFlags } from "./entry-paths.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const entry = fileURLToPath(new URL("./deploy.ts", import.meta.url));

test("the named path flags resolve against the directory the command started in", () => {
  const values = {
    out: ".local/release/serving.json",
    from: ".local/release/plan.json",
    "root-boot": "root-boot.json",
    stage: "production",
    fqn: "PoolWorker",
  };
  resolvePathFlags(values, ["out", "from", "root-boot"], "/repo");
  assert.deepEqual(values, {
    out: "/repo/.local/release/serving.json",
    from: "/repo/.local/release/plan.json",
    "root-boot": "/repo/root-boot.json",
    stage: "production",
    fqn: "PoolWorker",
  });
});

test("an absolute, empty or missing path flag is left as given", () => {
  const values: { out?: string; from?: string; serving?: string } = {
    out: "/elsewhere/out.json",
    from: "",
  };
  resolvePathFlags(values, ["out", "from", "serving"], "/repo");
  assert.deepEqual(values, { out: "/elsewhere/out.json", from: "" });
});

// The release runs `deploy.ts serving --from .local/release/plan.json`; the entry moves into the cloud
// app before it reads the file. A file that is not JSON shows which one it read: the one in the
// starting directory stops on SyntaxError, a path inside the cloud app on a missing file.
test("serving reads a relative --from in the starting directory, before anything goes out", async () => {
  const cwd = await mkdtemp(
    join(process.env.RUNNER_TEMP ?? join(homedir(), "Library", "Caches"), "entry-paths-"),
  );
  // The failed run's private detail lands in the repo's own .local/release, as a release's does.
  const kept = resolve(root, ".local/release/failure.txt");
  const before = await readFile(kept, "utf8").catch(() => undefined);
  try {
    await writeFile(join(cwd, "plan.json"), "not json");
    const run = spawnSync(
      process.execPath,
      [entry, "serving", "--stage", "test-entry-paths", "--from", "plan.json", "--out", "out.json"],
      { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "" }, timeout: 60_000 },
    );
    const output = `${run.stdout}\n${run.stderr}`;
    assert.notEqual(run.status, 0);
    assert.match(output, /Release stopped in serving: SyntaxError/u);
    assert.doesNotMatch(output, /Outgoing requests/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    if (before === undefined) await rm(kept, { force: true });
    else await writeFile(kept, before);
  }
});
