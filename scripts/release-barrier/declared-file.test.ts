import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeclaredChanges } from "./declared-file.ts";

const declaration = {
  schemaVersion: 1,
  stack: "basalt",
  retentionOwner: "Fixture storage owner",
  changes: [
    {
      action: "create-bucket",
      type: "Cloudflare.R2.Bucket",
      fqn: "DriveRecords",
      props: {
        jurisdiction: "eu",
        storageClass: "Standard",
        publicAccess: false,
        forceDestroy: false,
        domains: [],
        cors: [],
        lifecycleRules: [],
      },
      removalPolicy: "retain",
      retention: { data: true, nativeStateRow: true, recoveryDescriptor: true },
    },
  ],
};

test("the release loads its reviewed logical declaration from the fixed repository path", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "declared-file-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "release-declarations.json"), JSON.stringify(declaration));
  assert.deepEqual(await loadDeclaredChanges(root), declaration);
});
