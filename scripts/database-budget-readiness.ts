import {
  decodeRuntimeReady,
  deploymentReadinessPath,
  deploymentReadinessPrefix,
  type RuntimeReady,
} from "../src/pool/deployment-readiness.ts";
import { openPoolOperations, type PoolOperationsPlatform } from "./pool-operations.ts";
import { signEnvelope } from "../src/pool/token.ts";

class ReadinessResponseError extends Error {
  override readonly name = "ResponseError";
  readonly status: number;
  constructor(status: number) {
    super("Deployment runtime readiness failed");
    this.status = status;
  }
}

export async function openDeploymentReadiness(options: {
  worker: string;
  accountId: string;
  key: string;
  target: Pick<RuntimeReady, "candidate" | "workerInput" | "imageHash">;
  connect?: (path: string) => Promise<PoolOperationsPlatform>;
}) {
  const { service, close } = await openPoolOperations(options);
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
      if (!response.ok) {
        await bounded(response.body?.cancel() ?? Promise.resolve(), signal);
        throw new ReadinessResponseError(response.status);
      }
      return decodeRuntimeReady(await bounded(response.json(), signal), options.target);
    },
  };
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

export async function withinDeadline<T>(
  work: Promise<T>,
  milliseconds: number,
  schedule = liveDeadline,
) {
  const deadline = schedule(milliseconds);
  try {
    return await bounded(work, deadline.signal);
  } finally {
    deadline.dispose();
  }
}
