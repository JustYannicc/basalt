import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "../src/pool/backend-users.ts";
import { runTrafficOperator } from "./pool-traffic-operator.ts";

test("a lost purpose-apply reply retains its started receipt and cannot dispatch again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "traffic-operator-"));
  try {
    const selection = {
      pool: "fixture",
      purpose: "proof",
      evidence: "a".repeat(64),
      keys: [{ source: await digest("home-local-v1"), clientKey: "b".repeat(64) }],
    };
    const selectionPath = join(directory, "selection.json"),
      plan = join(directory, "plan.json");
    await writeFile(selectionPath, JSON.stringify(selection));
    let reads = 0,
      writes = 0;
    const options = {
      worker: "fixture-pool",
      accountId: "f".repeat(32),
      selection: selectionPath,
      plan,
      connect: async () => ({
        env: {
          POOL_OPERATIONS: {
            fetch: async (request: Request) => {
              const body = await request.json();
              if (body.go === true) {
                writes++;
                throw new Error("Reply lost after commit");
              }
              reads++;
              return Response.json({
                status: "dry-run",
                writes: false,
                selection,
                digest: "c".repeat(64),
                current: [],
                records: [],
              });
            },
          },
        },
        dispose: async () => {},
      }),
    };
    await runTrafficOperator(options);
    assert.equal(reads, 1);
    assert.equal(writes, 0);
    await assert.rejects(runTrafficOperator({ ...options, apply: true }), /Reply lost/);
    assert.equal(writes, 1);
    const receipt = JSON.parse(await readFile(`${plan}.result.json`, "utf8"));
    assert.equal(receipt.status, "started");
    await assert.rejects(runTrafficOperator({ ...options, apply: true }), { code: "EEXIST" });
    assert.equal(writes, 1, "uncertain mutation must not be duplicated");
    await assert.rejects(
      runTrafficOperator({ ...options, apply: true, worker: "other-pool" }),
      /target or selection changed/,
    );
    assert.equal(writes, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
