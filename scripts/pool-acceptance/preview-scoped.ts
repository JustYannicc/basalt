import { randomUUID } from "node:crypto";
import { PreviewClient, type SetupPayload } from "./preview-client.ts";
import { createNativePreviewSession } from "./preview-native.ts";
import { openCodexPreviewFixture } from "./codex-fixture.ts";
import type { PreviewStageConfig } from "./preview-config.ts";
import type { ScopedPreviewClientResult, ScopedPreviewResult } from "./preview-scoped-result.ts";

type PublicClient = Pick<
  PreviewClient,
  | "signIn"
  | "poolView"
  | "claimComputer"
  | "waitForToolCall"
  | "revokeComputer"
  | "verifyRevoked"
  | "signOut"
>;
type Model = { modelUrl: string; modelKey: string };
export async function runScopedPreviewAcceptance(
  config: PreviewStageConfig,
  model: Model,
  hooks: {
    client?: PublicClient;
    native?: typeof createNativePreviewSession;
    fixture?: typeof openCodexPreviewFixture;
  } = {},
): Promise<ScopedPreviewResult> {
  const client = hooks.client ?? new PreviewClient(config);
  const native = hooks.native ?? createNativePreviewSession;
  const result: ScopedPreviewResult = {
    version: 2,
    mode: "preview-scoped",
    signIn: false,
    poolEmpty: false,
    cleanup: false,
    clients: (["claude", "codex"] as const).map((client) => ({
      client,
      transport: client === "claude" ? "live" : "synthetic",
      exit: null,
      timeout: null,
      modelRequest: false,
      toolSearch: false,
      undo: false,
      revoke: false,
      ...(client === "codex" ? { chatgptAuthPreserved: false, refreshTokenUntouched: false } : {}),
    })),
  };
  const computers: Array<{ id: string; payload: SetupPayload; check: ScopedPreviewClientResult }> =
    [];
  const sessions: Array<{
    session: Awaited<ReturnType<typeof createNativePreviewSession>>;
    check: ScopedPreviewClientResult;
  }> = [];
  let fixture: Awaited<ReturnType<typeof openCodexPreviewFixture>> | undefined;
  let cleanup = true;
  let mutationPending = false;
  let signedIn = false;
  const startedAt = Date.now();
  try {
    signedIn = true;
    await client.signIn();
    result.signIn = true;
    const pool = await client.poolView();
    if (!pool.isOwner || pool.accounts.length !== 0) throw new Error("Preview pool must be empty");
    result.poolEmpty = true;
    for (const check of result.clients) {
      const marker = `preview-ok-${randomUUID()}`;
      mutationPending = true;
      const computer = await client.claimComputer(
        `Preview ${check.client} ${randomUUID().slice(0, 8)}`,
      );
      computers.push({ ...computer, check });
      if (check.client === "codex")
        fixture = await (hooks.fixture ?? openCodexPreviewFixture)(
          marker,
          computer.payload.brand.mcpServerName,
        );
      const selected = check.client === "codex" ? fixture! : model;
      const session = await native({
        client: check.client,
        model: check.client === "claude" ? "claude-opus-5-5" : fixture!.model,
        origin: config.origin,
        modelOrigin: selected.modelUrl,
        marker,
        payload: {
          ...computer.payload,
          credentials: {
            ...computer.payload.credentials,
            modelUrl: selected.modelUrl,
            modelKey: selected.modelKey,
          },
        },
        ...(check.client === "codex" ? { codexAuthFile: fixture!.authFile } : {}),
      });
      sessions.push({ session, check });
      mutationPending = false;
      const observed = await session.run();
      if (observed.modelReplyMatched !== true || observed.toolCallObserved !== true)
        throw new Error("Native preview evidence is incomplete");
      const { firstToolCallAt } = await client.waitForToolCall(computer.id);
      if (
        Date.parse(firstToolCallAt) < startedAt ||
        Date.parse(firstToolCallAt) > Date.now() + 60_000 ||
        !Number.isFinite(Date.parse(firstToolCallAt))
      )
        throw new Error("Preview tool evidence does not belong to this run");
      check.exit = 0;
      check.timeout = false;
      check.modelRequest = true;
      check.toolSearch = true;
      if (check.client === "codex") {
        const evidence = fixture!.evidence();
        if (
          evidence.requests < 2 ||
          !evidence.toolRequested ||
          !evidence.toolResultObserved ||
          evidence.failed ||
          observed.chatgptAuthPreserved !== true ||
          observed.refreshTokenUntouched !== true
        )
          throw new Error("Codex fixture evidence is incomplete");
        check.chatgptAuthPreserved = true;
        check.refreshTokenUntouched = true;
      }
    }
  } catch {
    if (mutationPending) cleanup = false;
  } finally {
    for (const { session, check } of sessions.toReversed()) {
      try {
        await session.undo();
        check.undo = true;
      } catch {
        cleanup = false;
      }
      try {
        await session.dispose();
      } catch {
        cleanup = false;
      }
    }
    for (const { id, payload, check } of computers.toReversed()) {
      let revoked = false;
      try {
        await client.revokeComputer(id);
        revoked = true;
      } catch {
        cleanup = false;
      }
      try {
        await client.verifyRevoked(payload.credentials, {
          client: check.client,
          model: check.client === "claude" ? "claude-opus-5-5" : "gpt-5.4",
        });
        check.revoke = revoked;
      } catch {
        cleanup = false;
      }
    }
    try {
      await fixture?.close();
    } catch {
      cleanup = false;
    }
    if (signedIn)
      try {
        await client.signOut();
      } catch {
        cleanup = false;
      }
    result.cleanup = cleanup;
  }
  return result;
}
