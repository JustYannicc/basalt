import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("the CLI exits nonzero and puts every allowlist refusal in stderr and the Actions summary", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "catalog-source-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(
    await readFile(new URL("./catalog-sources.json", import.meta.url), "utf8"),
  );
  manifest.apps[0].files.push("missing-aws.ts");
  manifest.apps[1].files.push("missing-atlassian.ts");
  const manifestPath = join(directory, "manifest.json");
  const summary = join(directory, "summary.md");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./catalog-sources.ts", import.meta.url)),
      "--check",
      "--manifest",
      manifestPath,
      "--summary",
      summary,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const report = await readFile(summary, "utf8");
  for (const text of [result.stderr, report]) {
    assert.match(text, /Catalog source drift for aws:.*missing-aws\.ts/);
    assert.match(text, /Catalog source drift for atlassian:.*missing-atlassian\.ts/);
    assert.match(text, / -> /);
  }
});
