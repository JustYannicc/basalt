import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { createAppHandler, hostContext, isolatedWorkflowControls } from "apps/host";
import { WorkflowFailure } from "apps/contracts";
import { invocationWorkflowControls } from "../../.upstream/packages/sdk/src/implementation/worker-workflow-rpc.ts";
import { storageFixture } from "../../src/drive/fixture.ts";
import { openVault } from "../../src/drive/vault.ts";
import { createDriveDispatcher } from "../../src/drive/dispatch.ts";
import app from "../../apps/obsidian/index.ts";

test("an installed import batch requires approval and lands both notes through the SDK callback", async () => {
  const data = storageFixture(),
    account = storageFixture();
  try {
    const vault = await openVault({
      ...data,
      accountStorage: account.storage,
      prefix: "public-batch/",
    });
    const unavailable = () =>
      Effect.fail(new WorkflowFailure({ reason: "unavailable", retryable: false }));
    const callback = await Effect.runPromise(
      invocationWorkflowControls(
        {
          start: unavailable,
          get: unavailable,
          list: unavailable,
          terminate: unavailable,
          drive: createDriveDispatcher(vault.drive),
        },
        new AbortController().signal,
      ),
    );
    const handler = createAppHandler(app),
      context = {
        ...hostContext({ app: {}, user: {} }),
        workflowControls: isolatedWorkflowControls(callback),
      };
    const input = {
      base: vault.root,
      operation: "batch",
      edits: [
        { path: "one.md", content: "first" },
        { path: "two.md", content: "second" },
      ],
    };
    const request = () =>
      new Request("https://fixture.invalid/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "call", tool: "applyNotes", kind: "mutation", input }),
      });
    assert.partialDeepStrictEqual(await (await handler(request(), context)).json(), {
      ok: false,
      error: { _tag: "HostToolApprovalRequired" },
    });
    assert.equal(await vault.service.read({ path: "one.md" }), null);
    const response = await handler(request(), {
      ...context,
      approval: { tool: "applyNotes", input },
    });
    assert.partialDeepStrictEqual(await response.json(), { ok: true, value: { state: "landed" } });
    assert.equal((await vault.service.read({ path: "one.md" }))?.content, "first");
    assert.equal((await vault.service.read({ path: "two.md" }))?.content, "second");
  } finally {
    data.close();
    account.close();
  }
});
