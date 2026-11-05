import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { PreviewClient } from "./preview-client.ts";
import { previewSetupConfigFromEnvironment, type PreviewSetupConfig } from "./preview-config.ts";
import { AcceptanceFailure, isObject } from "./types.ts";
import type { PreviewSavedAccount } from "./preview-pool.ts";

type Provider = "openai" | "anthropic";
interface SetupState {
  version: 1;
  origin: string;
  organizationId: string;
  poolAppId: string;
  providers: Record<
    Provider,
    { creation: string; app?: string; attempted?: boolean; account?: string }
  >;
  accounts: PreviewSavedAccount[];
}

async function privateState(path: string): Promise<unknown> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 1_048_576)
      throw new AcceptanceFailure("Preview account setup state must be a private regular file");
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Stage setup owns imports. The acceptance runner receives saved IDs and only changes pool links. */
export async function preparePreviewAccounts(
  config: PreviewSetupConfig,
  path: string,
  client = new PreviewClient(config),
): Promise<void> {
  const input = await privateState(path);
  const identity = {
    version: 1 as const,
    origin: config.origin,
    organizationId: config.organizationId,
    poolAppId: config.poolAppId,
  };
  let state: SetupState;
  if (input === undefined) {
    state = {
      ...identity,
      providers: {
        openai: { creation: randomUUID() },
        anthropic: { creation: randomUUID() },
      },
      accounts: [],
    };
    await writeFile(path, JSON.stringify(state), { flag: "wx", mode: 0o600 });
  } else {
    if (
      !isObject(input) ||
      Object.entries(identity).some(([key, value]) => input[key] !== value) ||
      !isObject(input.providers) ||
      !Array.isArray(input.accounts)
    )
      throw new AcceptanceFailure("Preview account setup state does not match the seeded stage");
    for (const lab of ["openai", "anthropic"] as const) {
      const value = input.providers[lab];
      if (
        !isObject(value) ||
        typeof value.creation !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value.creation,
        ) ||
        (value.app !== undefined &&
          (typeof value.app !== "string" || !/^app_[A-Za-z0-9_-]+$/.test(value.app))) ||
        (value.account !== undefined &&
          (typeof value.account !== "string" || !/^acc_[A-Za-z0-9_-]+$/.test(value.account)))
      )
        throw new AcceptanceFailure("Preview account setup state has invalid provider identities");
    }
    state = input as unknown as SetupState;
  }
  const save = async () => {
    const temp = `${path}.${randomUUID()}`;
    await writeFile(temp, JSON.stringify(state), { flag: "wx", mode: 0o600 });
    await rename(temp, path);
  };
  const request = async (method: string, route: string, input?: unknown) => {
    const response = await client.http.request(
      route,
      {
        method,
        headers: client.http.headers({ Origin: config.origin, "Content-Type": "application/json" }),
        ...(input === undefined
          ? {}
          : { body: client.http.encodeJson(input, "Preview provider setup") }),
      },
      "Preview provider setup",
    );
    await client.http.expectOk(response, "Preview provider setup");
    return response.status === 204
      ? null
      : client.http.readJson(response, "Preview provider setup");
  };
  const resourceId = (value: unknown, prefix: "app" | "acc") => {
    if (
      !isObject(value) ||
      typeof value.id !== "string" ||
      !new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(value.id)
    )
      throw new AcceptanceFailure("Preview provider setup omitted its resource ID");
    return value.id;
  };
  let signedIn = false;
  try {
    signedIn = true;
    await client.signIn();
    const prefix = `/api/organizations/${encodeURIComponent(config.organizationId)}`;
    for (const lab of ["openai", "anthropic"] as const) {
      const current = state.providers[lab];
      if (current.app === undefined) {
        // An uncertain installation cannot authorize a second app. Cleanup owns the whole stage.
        if (current.attempted)
          throw new AcceptanceFailure("Preview provider installation needs reconciliation");
        current.attempted = true;
        await save();
        current.app = resourceId(
          await request("POST", `${prefix}/apps/install`, {
            entry: `provider-${lab}`,
            name: `Preview ${lab === "openai" ? "OpenAI" : "Anthropic"}`,
          }),
          "app",
        );
        await save();
      }
      if (current.account === undefined) {
        current.account = resourceId(
          await request(
            "POST",
            `${prefix}/apps/${encodeURIComponent(current.app)}/accounts/app/${lab}/import-login-file`,
            {
              creation: current.creation,
              method: lab === "openai" ? "codex" : "claude",
              file: lab === "openai" ? config.codexLogin : config.claudeLogin,
            },
          ),
          "acc",
        );
        // A lost import response retries the journal's same creation UUID and exact file.
        await save();
      }
      await request(
        "PUT",
        `${prefix}/apps/${encodeURIComponent(current.app)}/accounts/app/${lab}/${encodeURIComponent(current.account)}`,
      );
    }
    state.accounts = (["openai", "anthropic"] as const).map((requirement) => ({
      id: state.providers[requirement].account!,
      requirement,
    }));
    await save();
  } finally {
    if (signedIn) await client.signOut();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const path = process.env.POOL_ACCEPTANCE_ACCOUNTS_FILE;
    if (!path) throw new Error("Missing private account setup output");
    await preparePreviewAccounts(await previewSetupConfigFromEnvironment(), path);
  } catch {
    console.error(
      "Preview provider account setup failed; no credentials or server response are logged.",
    );
    process.exitCode = 1;
  }
}
