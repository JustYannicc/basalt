import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { createAppHandler, hostContext } from "apps/host";
import { WorkflowFailure, DriveRequestFailed } from "apps/contracts";
import type { Json } from "../../.upstream/packages/sdk/src/contracts/shared.ts";
import { createDriveDispatcher } from "../../src/drive/dispatch.ts";
import app from "../../apps/obsidian/index.ts";
import { driveFixture } from "../../src/drive/fixture.ts";

test("the standard Obsidian app reads its authorized cloud drive through the public framework host", async () => {
  const f = await driveFixture();
  try {
    const unavailable = () =>
      Effect.fail(new WorkflowFailure({ reason: "unavailable", retryable: false }));
    const context = {
      ...hostContext({ app: {}, user: {} }),
      workflowControls: {
        start: unavailable,
        get: unavailable,
        list: unavailable,
        terminate: unavailable,
        drive: createDriveDispatcher(f.drive),
      },
    };
    const response = await createAppHandler(app)(
      new Request("https://fixture.invalid/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "call", tool: "listNotes", kind: "query", input: {} }),
      }),
      context,
    );
    assert.partialDeepStrictEqual(await response.json(), {
      ok: true,
      value: { at: f.root, exists: true, entries: [] },
    });
  } finally {
    f.close();
  }
});

test("the Obsidian app requires the existing approval before a cloud write", async () => {
  const f = await driveFixture();
  try {
    let dispatched = 0;
    const unavailable = () =>
      Effect.fail(new WorkflowFailure({ reason: "unavailable", retryable: false }));
    const input = {
      base: f.root,
      path: "approved.md",
      content: "cloud approval\n",
      operation: "approved-create",
    };
    const context = {
      ...hostContext({ app: {}, user: {} }),
      workflowControls: {
        start: unavailable,
        get: unavailable,
        list: unavailable,
        terminate: unavailable,
        drive: () => {
          dispatched++;
          return Effect.fail(new DriveRequestFailed({ reason: "unavailable" }));
        },
      },
    };
    const handler = createAppHandler(app);
    const response = await handler(
      new Request("https://fixture.invalid/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "call", tool: "createNote", kind: "mutation", input }),
      }),
      context,
    );
    assert.partialDeepStrictEqual(await response.json(), {
      ok: false,
      error: { _tag: "HostToolApprovalRequired" },
    });
    assert.equal(dispatched, 0);
  } finally {
    f.close();
  }
});

test("the SDK callback transport carries approved Obsidian writes and cloud reads", async () => {
  const { invocationWorkflowControls } =
    await import("../../.upstream/packages/sdk/src/implementation/worker-workflow-rpc.ts");
  const { isolatedWorkflowControls } = await import("apps/host");
  const { createDriveDispatcher } = await import("../../src/drive/dispatch.ts");
  const f = await driveFixture();
  try {
    const unavailable = () =>
      Effect.fail(new WorkflowFailure({ reason: "unavailable", retryable: false }));
    const callback = await Effect.runPromise(
      invocationWorkflowControls(
        {
          start: unavailable,
          get: unavailable,
          list: unavailable,
          terminate: unavailable,
          drive: createDriveDispatcher(f.drive),
        },
        new AbortController().signal,
      ),
    );
    const context = {
      ...hostContext({ app: {}, user: {} }),
      workflowControls: isolatedWorkflowControls(callback),
    };
    const handler = createAppHandler(app);
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
    const input = {
      base: f.root,
      path: "approved.md",
      content: "cloud-only write\n",
      operation: "through-sdk",
    };
    assert.partialDeepStrictEqual(await call("createNote", "mutation", input, true), {
      ok: true,
      value: { state: "landed" },
    });
    assert.partialDeepStrictEqual(await call("readNote", "query", { path: "approved.md" }), {
      ok: true,
      value: { content: input.content },
    });
    assert.partialDeepStrictEqual(await call("searchNotes", "query", { query: "cloud-only" }), {
      ok: true,
      value: { matches: [{ path: "approved.md" }] },
    });
  } finally {
    f.close();
  }
});

test("a workflow drive callback works only inside its exact active step", async () => {
  const { invocationWorkflow } =
    await import("../../.upstream/packages/sdk/src/implementation/worker-workflow-rpc.ts");
  const { WorkflowRunId } = await import("apps/contracts");
  let dispatched = 0;
  const unavailable = () =>
    Effect.fail(new WorkflowFailure({ reason: "unavailable", retryable: false }));
  const rpc = await Effect.runPromise(
    invocationWorkflow(
      {
        runId: WorkflowRunId.make("fixture-run"),
        drive: () =>
          Effect.sync(() => {
            dispatched++;
            return { accepted: true };
          }),
        resolve: unavailable,
        invoke: unavailable,
        driver: {
          do: (_name, _options, run) => run(),
          sleep: unavailable,
          sleepUntil: unavailable,
        },
      },
      new AbortController().signal,
    ),
  );
  const command = {
    operation: "drive",
    stepId: "exact-step",
    command: { operation: "drive", method: "list", input: {} },
  };
  assert.partialDeepStrictEqual(await rpc(command), { ok: false, error: { reason: "denied" } });
  assert.equal(dispatched, 0);
  const result = await rpc(
    {
      operation: "do",
      name: "fixture:read:exact-step",
      options: {},
      scope: { step: "read", stepId: "exact-step" },
    },
    async () => {
      assert.partialDeepStrictEqual(await rpc({ ...command, stepId: "forged-step" }), {
        ok: false,
        error: { reason: "denied" },
      });
      return { ok: true, value: await rpc(command) };
    },
  );
  assert.partialDeepStrictEqual(result, {
    ok: true,
    value: { ok: true, value: { accepted: true } },
  });
  assert.equal(dispatched, 1);
  assert.partialDeepStrictEqual(await rpc(command), { ok: false, error: { reason: "denied" } });
  assert.equal(dispatched, 1);
});

test("query and undeclared drive capabilities refuse before the backend runs", async () => {
  const { authorDrive } = await import("../../.upstream/packages/apps/src/implementation/drive.ts");
  let dispatched = 0;
  const host = () =>
    Effect.sync(() => {
      dispatched++;
      return null;
    });
  const input = {
    base: "a".repeat(40),
    path: "denied.md",
    content: "denied",
    operation: "denied",
    mode: "create" as const,
  };
  const readOnly = authorDrive(true, host, new AbortController().signal, false);
  await assert.rejects(readOnly.write(input));
  const undeclared = authorDrive(undefined, host, new AbortController().signal, true);
  await assert.rejects(undeclared.list());
  assert.equal(dispatched, 0);
});
