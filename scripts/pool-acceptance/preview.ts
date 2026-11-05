import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PreviewClient, type SetupPayload } from "./preview-client.ts";
import { createNativePreviewSession } from "./preview-native.ts";
import { previewConfigFromEnvironment, type PreviewConfig } from "./preview-config.ts";

type Client = "claude" | "codex";
type NativeSession = Awaited<ReturnType<typeof createNativePreviewSession>>;
type PublicClient = Pick<
  PreviewClient,
  | "signIn"
  | "poolView"
  | "waitForPoolAccounts"
  | "selectAccount"
  | "unselectAccount"
  | "claimComputer"
  | "waitForComputer"
  | "revokeComputer"
  | "verifyRevoked"
  | "signOut"
>;
export interface PreviewClientResult {
  client: Client;
  exit: 0 | null;
  timeout: false | null;
  modelRequest: boolean;
  toolSearch: boolean;
  undo: boolean;
  revoke: boolean;
}
export interface PreviewResult {
  version: 1;
  mode: "preview";
  signIn: boolean;
  pool: boolean;
  clients: PreviewClientResult[];
  cleanup: boolean;
}

function initialResult(): PreviewResult {
  return {
    version: 1,
    mode: "preview",
    signIn: false,
    pool: false,
    cleanup: false,
    clients: (["claude", "codex"] as const).map((client) => ({
      client,
      exit: null,
      timeout: null,
      modelRequest: false,
      toolSearch: false,
      undo: false,
      revoke: false,
    })),
  };
}

export function previewPassed(result: PreviewResult): boolean {
  return (
    result.version === 1 &&
    result.mode === "preview" &&
    result.signIn === true &&
    result.pool === true &&
    result.cleanup === true &&
    result.clients.length === 2 &&
    new Set(result.clients.map((client) => client.client)).size === 2 &&
    ["claude", "codex"].every((name) =>
      result.clients.some(
        (client) =>
          client.client === name &&
          client.exit === 0 &&
          client.timeout === false &&
          client.modelRequest === true &&
          client.toolSearch === true &&
          client.undo === true &&
          client.revoke === true,
      ),
    )
  );
}

export async function runPreviewAcceptance(
  config: PreviewConfig,
  hooks: {
    client?: PublicClient;
    native?: typeof createNativePreviewSession;
  } = {},
): Promise<PreviewResult> {
  const client = hooks.client ?? new PreviewClient(config);
  const native = hooks.native ?? createNativePreviewSession;
  const result = initialResult();
  const startedAt = Date.now();
  const accounts: PreviewConfig["accounts"][number][] = [];
  const computers: { id: string; payload: SetupPayload; result: PreviewClientResult }[] = [];
  const sessions: { session: NativeSession; result: PreviewClientResult }[] = [];
  let signedIn = false;
  let cleanupSucceeded = true;
  let mutationPending = false;
  try {
    // Sign out even when login fails after the server has issued its cookie.
    signedIn = true;
    await client.signIn();
    result.signIn = true;
    const pool = await client.poolView();
    if (!pool.isOwner || pool.accounts.length !== 0)
      throw new Error("Expected an empty isolated preview pool");
    for (const account of config.accounts) {
      mutationPending = true;
      accounts.push(account);
      await client.selectAccount(account);
      mutationPending = false;
    }
    const selected = await client.waitForPoolAccounts(2);
    if (
      !selected.isOwner ||
      selected.accounts.length !== 2 ||
      new Set(selected.accounts.map((account) => account.id)).size !== 2
    )
      throw new Error("Unexpected preview pool accounts");
    result.pool = true;
    for (const check of result.clients) {
      const name = check.client;
      const marker = `preview-ok-${randomUUID()}`;
      mutationPending = true;
      const computer = await client.claimComputer(`Preview ${name} ${randomUUID().slice(0, 8)}`);
      computers.push({ ...computer, result: check });
      const session = await native({
        client: name,
        model: config.models[name],
        origin: config.origin,
        payload: computer.payload,
        marker,
        codexAuthFile: name === "codex" ? config.codexAuthFile : undefined,
      });
      sessions.push({ session, result: check });
      mutationPending = false;
      const observed = await session.run();
      if (observed.modelReplyMatched !== true || observed.toolCallObserved !== true)
        throw new Error("Native proof incomplete");
      check.exit = 0;
      check.timeout = false;
      const timestamps = await client.waitForComputer(computer.id);
      const { firstModelRequestAt, firstToolCallAt } = timestamps;
      if (
        [firstModelRequestAt, firstToolCallAt].some(
          (value) =>
            typeof value !== "string" ||
            !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
            !Number.isFinite(Date.parse(value)) ||
            Date.parse(value) < startedAt ||
            Date.parse(value) > Date.now() + 60_000,
        )
      ) {
        throw new Error("Computer timestamps do not belong to this run");
      }
      check.modelRequest = true;
      check.toolSearch = true;
    }
  } catch {
    // Errors can contain server responses, CLI output or credential-bearing paths.
    if (mutationPending) cleanupSucceeded = false;
  } finally {
    for (const { session, result: check } of sessions.reverse()) {
      try {
        await session.undo();
        check.undo = true;
      } catch {
        cleanupSucceeded = false;
      }
      try {
        await session.dispose();
      } catch {
        cleanupSucceeded = false;
      }
    }
    for (const computer of computers.reverse()) {
      let revoked = false;
      try {
        await client.revokeComputer(computer.id);
        revoked = true;
      } catch {
        cleanupSucceeded = false;
      }
      try {
        await client.verifyRevoked(computer.payload.credentials, {
          client: computer.result.client,
          model: config.models[computer.result.client],
        });
        computer.result.revoke = revoked;
      } catch {
        cleanupSucceeded = false;
      }
    }
    for (const account of accounts.reverse()) {
      try {
        await client.unselectAccount(account);
      } catch {
        cleanupSucceeded = false;
      }
    }
    if (accounts.length) {
      try {
        const remaining = await client.waitForPoolAccounts(0);
        if (remaining.accounts.length !== 0) cleanupSucceeded = false;
      } catch {
        cleanupSucceeded = false;
      }
    }
    if (signedIn) {
      try {
        await client.signOut();
      } catch {
        cleanupSucceeded = false;
      }
    }
    result.cleanup = cleanupSucceeded;
  }
  return result;
}

export async function runPreviewFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  let result = initialResult();
  try {
    result = await runPreviewAcceptance(await previewConfigFromEnvironment(env));
  } catch {
    /* Configuration failures never expose secret values or file paths. */
  }
  if (env.POOL_ACCEPTANCE_RESULT_PATH) {
    try {
      // A fresh file avoids following an existing symlink or replacing another report.
      await writeFile(env.POOL_ACCEPTANCE_RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
    } catch {
      return false;
    }
  }
  return previewPassed(result);
}
