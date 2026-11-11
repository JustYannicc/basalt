import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect, Schema } from "effect";
import { createAppHandler, hostContext, isolatedWorkflowControls } from "apps/host";
import { WorkflowFailure } from "apps/contracts";
import { invocationWorkflowControls } from "../../.upstream/packages/sdk/src/implementation/worker-workflow-rpc.ts";
import { storageFixture } from "../../src/drive/fixture.ts";
import { openVault } from "../../src/drive/vault.ts";
import { createDriveDispatcher } from "../../src/drive/dispatch.ts";
import { defaultLimits } from "../../src/drive/quota-limits.ts";
import app from "../../apps/obsidian/index.ts";
import { createRemote } from "../../clients/obsidian/remote.ts";
import { createSync } from "../../clients/obsidian/sync.ts";
import { decodeState } from "../../clients/obsidian/state.ts";
import { object, text, type Http } from "../../clients/obsidian/http.ts";
import type { LocalVault, SyncState } from "../../clients/obsidian/types.ts";

const queries = new Set([
  "importStatus",
  "listNotes",
  "readNote",
  "changes",
  "fileInfo",
  "readAttachment",
  "operationStatus",
]);

/**
 * The real Obsidian app and vault behind the plugin's MCP transport. `calls` records every tool
 * call (`tool` or `importRequest:<drive method>`); `afterCall` runs once the server has handled a
 * call, so a test can lose its reply.
 */
async function importFixture(files: Map<string, string>) {
  const data = storageFixture(),
    account = storageFixture();
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
  const calls: string[] = [];
  const hooks: { afterCall?: (tool: string, input: unknown) => void } = {};
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
    const call = object(object(object(rpc.params).arguments).calls),
      path = text(call, "path"),
      tool = path.split(".").at(-1)!;
    const drive = tool === "importRequest" ? object(object(call.input).request).method : null;
    calls.push(drive ? `${tool}:${String(drive)}` : tool);
    const response = await handler(
      new Request("https://fixture.invalid/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "call",
          tool,
          kind: queries.has(tool) ? "query" : "mutation",
          input: call.input,
        }),
      }),
      { ...context, approval: { tool, input: Schema.decodeUnknownSync(Schema.Json)(call.input) } },
    );
    const outcome = object(await response.json());
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    hooks.afterCall?.(tool, call.input);
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
  let state: SyncState | null = null;
  const start = (progress?: () => void) =>
    createSync({
      local,
      remote: createRemote({
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
      }),
      id: () => crypto.randomUUID(),
      store: {
        load: async () => decodeState(structuredClone(state)),
        save: async (value) => {
          state = structuredClone(value);
        },
      },
      ...(progress ? { progress } : {}),
    });
  return {
    vault,
    account,
    calls,
    hooks,
    start,
    close() {
      data.close();
      account.close();
    },
  };
}

test("the plugin resumes manifest and batch replies through the public SDK without spending monthly writes", async () => {
  const files = new Map(Array.from({ length: 105 }, (_, i) => [`notes/${i}.md`, `note ${i}`]));
  const fixture = await importFixture(files);
  try {
    let losePlan = true,
      loseBatch = true,
      batches = 0;
    fixture.hooks.afterCall = (tool, input) => {
      if (tool === "planImport" && losePlan) {
        losePlan = false;
        throw new Error("Plan reply lost");
      }
      if (tool === "importRequest" && object(object(input).request).method === "apply") {
        batches++;
        if (loseBatch) {
          loseBatch = false;
          throw new Error("Batch reply lost");
        }
      }
    };
    fixture.account.storage.sql.exec(`UPDATE vault_io SET class_a=${defaultLimits.classA}`);
    await assert.rejects((await fixture.start()).run(), /Plan reply lost/);
    files.set("notes/0.md", "edited before upload");
    files.delete("notes/1.md");
    await assert.rejects((await fixture.start()).run(), /Batch reply lost/);
    const resumed = await fixture.start();
    await resumed.run();
    assert.equal(batches, 2);
    const imported = await fixture.vault.imports.status();
    assert.equal(imported?.state, "complete");
    assert.equal(imported?.omitted, 1);
    assert.equal(imported?.confirmed, 105);
    assert.equal((await fixture.vault.status()).classA, defaultLimits.classA);
    assert.equal(
      (await fixture.vault.service.read({ path: "notes/0.md" }))?.content,
      "edited before upload",
    );
    assert.equal(await fixture.vault.service.read({ path: "notes/1.md" }), null);
    await resumed.run();
    assert.equal(batches, 2);
  } finally {
    fixture.close();
  }
});

test("a first import lands without reading every file back and reports progress as batches land", async () => {
  // The size of a real vault that sat at "0 of 133" for minutes: each landed file was read back
  // with two calls, 266 sequential round trips, and progress only showed once the import ended.
  const files = new Map(
    Array.from({ length: 133 }, (_, i) => [`notes/${i}.md`, `# Note ${i}\n${"x".repeat(3300)}\n`]),
  );
  const fixture = await importFixture(files);
  try {
    const confirmed: number[] = [];
    let sync: Awaited<ReturnType<typeof fixture.start>> | undefined;
    sync = await fixture.start(() => {
      const count = sync?.status().initial?.confirmed;
      if (count !== undefined) confirmed.push(count);
    });
    await sync.run();
    const imported = await fixture.vault.imports.status();
    assert.equal(imported?.state, "complete");
    assert.equal(imported?.confirmed, 133);
    const readBacks = fixture.calls.filter((call) =>
      /^(readNote|fileInfo|importRequest:read|importRequest:info)$/u.test(call),
    );
    assert.deepEqual(readBacks, [], "landed files must not be read back one by one");
    assert.ok(
      fixture.calls.length <= 16,
      `${fixture.calls.length} calls: ${fixture.calls.join(", ")}`,
    );
    // The count moves after each landed batch, not only when the whole import ends.
    assert.ok(confirmed.includes(100), `progress seen: ${confirmed.join(", ")}`);
    assert.equal(
      (await fixture.vault.service.read({ path: "notes/132.md" }))?.content,
      files.get("notes/132.md"),
    );
  } finally {
    fixture.close();
  }
});
