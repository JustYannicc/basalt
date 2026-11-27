import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateTreeRefusal,
  healRelease,
  laneSubject,
  redRelease,
  rollbackRetry,
  runEntry,
  runStageMode,
  stageRelease,
} from "./stage.ts";

const refused = (error: Error) => error.message === candidateTreeRefusal;

test("release, classplan, redrelease, retry and heal refuse before anything else runs", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-refuse-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  for (const entry of [stageRelease, redRelease, rollbackRetry, healRelease])
    assert.throws(entry, refused, entry.name);
  for (const mode of ["release", "classplan", "redrelease", "retry", "heal"] as const) {
    const outputs = join(at, mode);
    // Outside Actions every other mode refuses on that first; this refusal came before it, so no
    // fetch, State read, plan or checkout ran, and no output directory or record was written.
    await assert.rejects(
      runStageMode(mode, 2, { PATH: process.env.PATH, BASALT_STAGE_OUTPUT_DIR: outputs }),
      refused,
      mode,
    );
    assert.equal(existsSync(outputs), false, mode);
  }
});

test("runEntry refuses any tree but the harness's own before its entry or stage env", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-foreign-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  const tree = join(at, "candidate");
  await mkdir(join(tree, "scripts/release"), { recursive: true });
  await writeFile(
    join(tree, "scripts/release/deploy.ts"),
    'import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("../../entry-ran", import.meta.url), "ran");\n',
  );
  for (const command of ["plan", "deploy", "rollback", "accept"] as const)
    // An empty source: the stage env would refuse otherwise, so this refusal came first.
    await assert.rejects(
      runEntry(command, laneSubject(2), {}, {}, join(at, "outputs"), { policy: null, tree }),
      refused,
      command,
    );
  assert.equal(existsSync(join(tree, "entry-ran")), false);
  assert.equal(existsSync(join(at, "outputs")), false);
});
