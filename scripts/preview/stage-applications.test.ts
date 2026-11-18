import assert from "node:assert/strict";
import { test } from "node:test";
import { stageApplications } from "./stage-applications.ts";
import { ownedByStage } from "./stage-images.ts";

const stage = "test-rehearsal-81231";

test("only this stage's resources are owned, by whole stage name", () => {
  for (const name of [`basalt-${stage}-pool-runtime-blue`, `basalt-${stage}-pool-runtime`, `basalt-rehearsal-poolcontainer-${stage}-abc`])
    assert.equal(ownedByStage(name, stage), true, name);
  for (const name of [
    "basalt-production-pool-runtime-blue",
    `basalt-${stage}1-pool-runtime-blue`,
    `basalt-rehearsal-poolcontainer-${stage}1`,
    `basalt-poolcontainer-${stage}`,
    "basalt-test-pr-12-pool-runtime-blue",
  ])
    assert.equal(ownedByStage(name, stage), false, name);
  assert.throws(() => ownedByStage("basalt-production-x", "production"));
});

test("retained fleet applications of the stage are deleted, and verify refuses any left", async () => {
  let apps = [
    { id: "a", name: `basalt-${stage}-pool-runtime-blue` },
    { id: "b", name: `basalt-${stage}-pool-runtime-green` },
    { id: "c", name: "basalt-production-pool-runtime-blue" },
  ];
  const deleted: string[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "DELETE") {
      const id = url.split("/").at(-1)!;
      assert.notEqual(id, "c", "a production application was deleted");
      deleted.push(id);
      apps = apps.filter((app) => app.id !== id);
      return Response.json({ success: true });
    }
    return Response.json({ success: true, result: apps });
  }) as typeof fetch;
  const input = { accountId: "1".repeat(32), token: "t", stage };
  assert.deepEqual(await stageApplications("delete", input, fetcher), [`basalt-${stage}-pool-runtime-blue`, `basalt-${stage}-pool-runtime-green`]);
  assert.deepEqual(deleted, ["a", "b"]);
  await stageApplications("verify", input, fetcher);
  apps.push({ id: "d", name: `basalt-${stage}-pool-runtime-blue` });
  await assert.rejects(stageApplications("verify", input, fetcher), /applications remain/);
});
