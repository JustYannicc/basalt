import { nodePoolOperations } from "./pool-operations-node.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PoolOperationsPlatform {
  env: { POOL_OPERATIONS: { fetch(request: Request): Promise<Response> } };
  dispose(): Promise<void>;
}
export interface PoolOperationsTarget {
  worker: string;
  accountId: string;
  connect?: (path: string) => Promise<PoolOperationsPlatform>;
}

/** A scoped local bridge can reach only the named private operations entrypoint. */
export async function openPoolOperations(options: PoolOperationsTarget) {
  if (!options.connect && process.versions.bun) {
    const platform = await nodePoolOperations(options.accountId, options.worker);
    return { service: platform.env.POOL_OPERATIONS, close: () => platform.dispose() };
  }
  const directory = await mkdtemp(join(tmpdir(), "database-budget-ready-"));
  let platform: PoolOperationsPlatform | undefined;
  const close = async () => {
    try {
      await platform?.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    const configPath = join(directory, "wrangler.json");
    await writeFile(
      configPath,
      JSON.stringify({
        name: "database-budget-ready",
        account_id: options.accountId,
        compatibility_date: "2026-09-08",
        services: [
          {
            binding: "POOL_OPERATIONS",
            service: options.worker,
            entrypoint: "PoolOperations",
            remote: true,
          },
        ],
      }),
      { mode: 0o600 },
    );
    platform = await (
      options.connect ??
      (async (path: string): Promise<PoolOperationsPlatform> => {
        const { getPlatformProxy } = createRequire(
          new URL("./startup-profiler/package.json", import.meta.url),
        )("wrangler");
        return getPlatformProxy({ configPath: path, persist: false, remoteBindings: true });
      })
    )(configPath);
    return { service: platform.env.POOL_OPERATIONS, close };
  } catch (error) {
    await close();
    throw error;
  }
}
