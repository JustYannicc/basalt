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
import { blobId } from "../../clients/obsidian/types.ts";

test("an approved installed-app write reports the exact quota resource and retains the accepted revision", async () => {
  const data = storageFixture(),
    account = storageFixture();
  try {
    const vault = await openVault({
      ...data,
      accountStorage: account.storage,
      prefix: "public-quota/",
      limits: { currentBytes: 1 },
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
          drive: createDriveDispatcher(
            vault.drive,
            vault.attachments,
            vault.changes,
            vault.root,
            vault.imports,
          ),
        },
        new AbortController().signal,
      ),
    );
    const input = { base: vault.root, path: "refused.md", content: "xx", operation: "refused" };
    const response = await createAppHandler(app)(
      new Request("https://fixture.invalid/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "call", tool: "createNote", kind: "mutation", input }),
      }),
      {
        ...hostContext({ app: {}, user: {} }),
        workflowControls: isolatedWorkflowControls(callback),
        approval: { tool: "createNote", input },
      },
    );
    const result: unknown = await response.json();
    assert.partialDeepStrictEqual(result, { ok: false });
    assert.match(JSON.stringify(result), /currentBytes/);
    assert.match(JSON.stringify(result), /limit 1/);
    assert.equal(await vault.service.read({ path: "refused.md" }), null);
    assert.equal((await vault.status()).currentBytes, 0);
    const manifest = {
      id: "first",
      page: 0,
      entries: [{ path: "refused.md", kind: "note", bytes: 2, hash: await blobId("xx") }],
      final: true,
    };
    const planned = await createAppHandler(app)(
      new Request("https://fixture.invalid/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "call",
          tool: "planImport",
          kind: "mutation",
          input: manifest,
        }),
      }),
      {
        ...hostContext({ app: {}, user: {} }),
        workflowControls: isolatedWorkflowControls(callback),
        approval: { tool: "planImport", input: manifest },
      },
    );
    const refusal: unknown = await planned.json();
    assert.partialDeepStrictEqual(refusal, { ok: false });
    assert.match(JSON.stringify(refusal), /currentBytes/);
    assert.match(JSON.stringify(refusal), /limit 1/);
    assert.equal((await vault.service.list()).at, vault.root);
  } finally {
    data.close();
    account.close();
  }
});
