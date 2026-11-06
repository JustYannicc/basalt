import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeRuntimeReady,
  deploymentReadinessPath,
  deploymentReadinessPrefix,
  type RuntimeReady,
} from "../src/pool/deployment-readiness.ts";
import { signEnvelope } from "../src/pool/token.ts";

interface Platform {
  env: { POOL_OPERATIONS: { fetch(request: Request): Promise<Response> } };
  dispose(): Promise<void>;
}
export async function openDeploymentReadiness(options: {
  worker: string;
  accountId: string;
  key: string;
  target: Pick<RuntimeReady, "candidate" | "workerInput" | "imageHash">;
  connect?: (path: string) => Promise<Platform>;
}) {
  const directory = await mkdtemp(join(tmpdir(), "database-budget-ready-"));
  let platform: Platform | undefined;
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
      (async (path: string): Promise<Platform> => {
        const { getPlatformProxy } = createRequire(
          new URL("./startup-profiler/package.json", import.meta.url),
        )("wrangler");
        return getPlatformProxy({ configPath: path, persist: false, remoteBindings: true });
      })
    )(configPath);
    const service = platform.env.POOL_OPERATIONS;
    return {
      close,
      ready: async (signal: AbortSignal) => {
        const at = Date.now();
        const envelope = await signEnvelope(options.key, deploymentReadinessPrefix, {
          ...options.target,
          at,
          expiresAt: at + 60_000,
        });
        const response = await bounded(
          service.fetch(
            new Request(`http://pool-operations${deploymentReadinessPath}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ envelope }),
              signal,
            }),
          ),
          signal,
        );
        if (!response.ok) throw new Error("Deployment runtime readiness failed");
        return decodeRuntimeReady(await bounded(response.json(), signal), options.target);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Remote service bridges may ignore Request.signal; the caller still owns its deadline. */
export function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Operation aborted", "AbortError"));
    // Work may reject while it synchronously aborts the supplied signal.
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** AbortSignal.timeout does not keep a standalone verifier process alive. */
export function liveDeadline(milliseconds: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

export async function withinDeadline<T>(work: Promise<T>, milliseconds: number) {
  const deadline = liveDeadline(milliseconds);
  try {
    return await bounded(work, deadline.signal);
  } finally {
    deadline.dispose();
  }
}
