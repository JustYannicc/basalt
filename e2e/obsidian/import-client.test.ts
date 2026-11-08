import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect, Schema } from "effect";
import { createAppHandler, hostContext, isolatedWorkflowControls } from "apps/host";
import { WorkflowFailure } from "apps/contracts";
import { invocationWorkflowControls } from "../../.upstream/packages/sdk/src/implementation/worker-workflow-rpc.ts";
import { storageFixture } from "../../src/drive/fixture.ts";
import { openVault } from "../../src/drive/vault.ts";
import { createDriveDispatcher } from "../../src/drive/dispatch.ts";
import app from "../../apps/obsidian/index.ts";
import { createRemote } from "../../clients/obsidian/remote.ts";
import { createSync } from "../../clients/obsidian/sync.ts";
import { decodeState } from "../../clients/obsidian/state.ts";
import { object, text, type Http } from "../../clients/obsidian/http.ts";
import type { LocalVault, SyncState } from "../../clients/obsidian/types.ts";

test("the plugin resumes manifest and batch replies through the public SDK without spending monthly writes", async () => {
  const data = storageFixture(),
    account = storageFixture();
  try {
    const vault = await openVault({
      ...data,
      accountStorage: account.storage,
      prefix: "plugin-import/",
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
    const handler = createAppHandler(app),
      context = {
        ...hostContext({ app: {}, user: {} }),
        workflowControls: isolatedWorkflowControls(callback),
      };
    const files = new Map(Array.from({ length: 105 }, (_, i) => [`notes/${i}.md`, `note ${i}`]));
    let state: SyncState | null = null,
      losePlan = true,
      loseBatch = true,
      batches = 0;
    const queries = new Set([
      "importStatus",
      "listNotes",
      "readNote",
      "changes",
      "fileInfo",
      "readAttachment",
      "operationStatus",
    ]);
    const http: Http = async (_url, request) => {
      if (request.method === "DELETE") return { status: 204, headers: {}, body: "" };
      const rpc = object(JSON.parse(request.body ?? "{}")),
        method = text(rpc, "method");
      const reply = (result: unknown) => ({
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "synthetic-session" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }),
      });
      if (method === "initialize")
        return reply({
          protocolVersion: "2025-11-25",
          capabilities: {},
          serverInfo: { name: "fixture", version: "1" },
        });
      if (method === "notifications/initialized") return { status: 202, headers: {}, body: "" };
      const calls = object(object(object(rpc.params).arguments).calls),
        path = text(calls, "path"),
        tool = path.split(".").at(-1)!;
      const response = await handler(
        new Request("https://fixture.invalid/dispatch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            operation: "call",
            tool,
            kind: queries.has(tool) ? "query" : "mutation",
            input: calls.input,
          }),
        }),
        {
          ...context,
          approval: { tool, input: Schema.decodeUnknownSync(Schema.Json)(calls.input) },
        },
      );
      const outcome = object(await response.json());
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
      if (tool === "planImport" && losePlan) {
        losePlan = false;
        throw new Error("Plan reply lost");
      }
      if (tool === "importRequest" && object(object(calls.input).request).method === "apply") {
        batches++;
        if (loseBatch) {
          loseBatch = false;
          throw new Error("Batch reply lost");
        }
      }
      return reply({
        structuredContent: {
          status: "completed",
          execution: { ok: true, value: { path, ok: true, value: outcome.value } },
        },
      });
    };
    const local: LocalVault = {
      files: async () =>
        [...files].map(([path, content]) => ({
          path,
          bytes: Buffer.byteLength(content),
          stamp: content,
        })),
      read: async (path) => files.get(path) ?? null,
      replace: async (path, expected, content) => {
        if ((files.get(path) ?? null) !== expected) return false;
        if (content === null) files.delete(path);
        else files.set(path, content);
        return true;
      },
    };
    const start = () => {
      const remote = createRemote({
        http,
        appSlug: "obsidian",
        saveSession: async () => {},
        session: {
          resource: "https://cloud.fixture.invalid/mcp?connection=device&elicitation_mode=native",
          clientId: "fixture",
          tokenEndpoint: "https://identity.fixture.invalid/token",
          revocationEndpoint: null,
          accessToken: "synthetic",
          refreshToken: "synthetic",
          expiresAt: Date.now() + 3600000,
        },
      });
      return createSync({
        local,
        remote,
        id: () => crypto.randomUUID(),
        store: {
          load: async () => decodeState(structuredClone(state)),
          save: async (value) => {
            state = structuredClone(value);
          },
        },
      });
    };
    account.storage.sql.exec("UPDATE vault_io SET class_a=5000");
    await assert.rejects((await start()).run(), /Plan reply lost/);
    files.set("notes/0.md", "edited before upload");
    files.delete("notes/1.md");
    await assert.rejects((await start()).run(), /Batch reply lost/);
    const resumed = await start();
    await resumed.run();
    assert.equal(batches, 2);
    const imported = await vault.imports.status();
    assert.equal(imported?.state, "complete");
    assert.equal(imported?.omitted, 1);
    assert.equal(imported?.confirmed, 105);
    assert.equal((await vault.status()).classA, 5000);
    assert.equal(
      (await vault.service.read({ path: "notes/0.md" }))?.content,
      "edited before upload",
    );
    assert.equal(await vault.service.read({ path: "notes/1.md" }), null);
    await resumed.run();
    assert.equal(batches, 2);
  } finally {
    data.close();
    account.close();
  }
});
