import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

for (const tree of ["src", "lib"])
  test(`the real ${tree} SDK adopts one existing observation store, settles it, replans noop and refuses creation`, () => {
    const output = execFileSync(
      tree === "src" ? "bun" : process.execPath,
      [fileURLToPath(new URL("./test/observation-store-proof.mjs", import.meta.url)), tree],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.match(output, /__OBSERVATION_STORE_PROOF_PASS__/);
  });

test("invalid workflow plan input records a safe failure before stack evaluation or network access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observation-store-plan-input-"));
  try {
    const preload = join(directory, "deny-network.mjs");
    await writeFile(
      preload,
      'globalThis.fetch = () => { throw new Error("REAL NETWORK DENIED"); };',
    );
    const result = spawnSync(
      process.execPath,
      ["--import", preload, fileURLToPath(new URL("./provisioning-entry.ts", import.meta.url))],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_WORKFLOW_REF:
            "synthetic/basalt/.github/workflows/pool-runtime-provision.yml@refs/heads/main",
          GITHUB_SHA: "a".repeat(40),
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
          CLOUDFLARE_ACCOUNT_ID: "1".repeat(32),
          ALCHEMY_STAGE: "production",
          POOL_PROVISIONING_MODE: "plan",
          POOL_PROVISIONING_OUTPUT_DIRECTORY: directory,
          POOL_PROVISIONING_PACKET: JSON.stringify({
            kind: "observation-store",
            unexpected: "synthetic-never-print",
          }),
        },
      },
    );
    assert.equal(result.status, 1, result.stderr);
    const failure = await readFile(join(directory, "failure.json"), "utf8");
    assert.equal(failure.includes("synthetic-never-print"), false);
    assert.equal((result.stdout + result.stderr).includes("synthetic-never-print"), false);
    assert.equal((result.stdout + result.stderr).includes("REAL NETWORK DENIED"), false);
    assert.ok(JSON.parse(failure).reason);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
