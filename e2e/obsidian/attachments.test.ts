import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { createAppHandler, hostContext, isolatedWorkflowControls } from "apps/host";
import { WorkflowFailure } from "apps/contracts";
import { invocationWorkflowControls } from "../../.upstream/packages/sdk/src/implementation/worker-workflow-rpc.ts";
import { storageFixture } from "../../src/drive/fixture.ts";
import { openVault } from "../../src/drive/vault.ts";
import { createDriveDispatcher } from "../../src/drive/dispatch.ts";
import app from "../../apps/obsidian/index.ts";
import type { Json } from "../../.upstream/packages/sdk/src/contracts/shared.ts";

test("the public app uploads verified bytes behind approval and restores an attachment from retained history", async () => {
  const data = storageFixture(),
    account = storageFixture();
  try {
    const vault = await openVault({
        ...data,
        accountStorage: account.storage,
        prefix: "public-bytes/",
      }),
      unavailable = () =>
        Effect.fail(new WorkflowFailure({ reason: "unavailable", retryable: false }));
    const callback = await Effect.runPromise(
      invocationWorkflowControls(
        {
          start: unavailable,
          get: unavailable,
          list: unavailable,
          terminate: unavailable,
          drive: createDriveDispatcher(vault.drive, vault.attachments),
        },
        new AbortController().signal,
      ),
    );
    const handler = createAppHandler(app),
      context = {
        ...hostContext({ app: {}, user: {} }),
        workflowControls: isolatedWorkflowControls(callback),
      };
    const call = async (
      tool: string,
      kind: "query" | "mutation",
      input: Json,
      approved = false,
    ) => {
      const response = await handler(
        new Request("https://fixture.invalid/dispatch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operation: "call", tool, kind, input }),
        }),
        { ...context, ...(approved ? { approval: { tool, input } } : {}) },
      );
      return response.json();
    };
    const bytes = Buffer.from("\0verified attachment\xff"),
      oid = createHash("sha256").update(bytes).digest("hex"),
      begin = { operation: "upload", oid, bytes: bytes.length };
    assert.partialDeepStrictEqual(await call("beginAttachment", "mutation", begin), {
      ok: false,
      error: { _tag: "HostToolApprovalRequired" },
    });
    const started = await call("beginAttachment", "mutation", begin, true);
    assert.equal(started.ok, true);
    assert.equal(started.value.state, "uploading");
    assert.partialDeepStrictEqual(
      await call(
        "uploadAttachmentPart",
        "mutation",
        { upload: started.value.upload, part: 0, contentBase64: bytes.toString("base64") },
        true,
      ),
      { ok: true, value: { part: 0, bytes: bytes.length } },
    );
    assert.partialDeepStrictEqual(
      await call("completeAttachment", "mutation", { upload: started.value.upload }, true),
      { ok: true, value: { state: "present", oid, bytes: bytes.length } },
    );
    const saved = await call(
      "attachFile",
      "mutation",
      { base: vault.root, path: "file.pdf", operation: "attach", oid, bytes: bytes.length },
      true,
    );
    assert.equal(saved.ok, true);
    assert.equal(saved.value.state, "landed");
    assert.partialDeepStrictEqual(
      await call("fileInfo", "query", { at: saved.value.oid, path: "file.pdf" }),
      { ok: true, value: { bytes: bytes.length, attachment: { oid, bytes: bytes.length } } },
    );
    assert.partialDeepStrictEqual(
      await call("readAttachment", "query", { at: saved.value.oid, path: "file.pdf" }),
      {
        ok: true,
        value: { contentBase64: bytes.toString("base64"), bytes: bytes.length, next: null },
      },
    );
    assert.equal((await vault.status()).currentBytes, bytes.length);
  } finally {
    data.close();
    account.close();
  }
});
