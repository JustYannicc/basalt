import {
  decodeRuntimeReady,
  decodeRuntimeIdentity,
  sameRuntimeTarget,
  deploymentReadinessPath,
  deploymentReadinessPrefix,
  type RuntimeReady,
  type ReadinessPhase,
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
  const request = async (signal: AbortSignal, phase: ReadinessPhase) => {
    const at = Date.now();
    const envelope = await signEnvelope(options.key, deploymentReadinessPrefix, {
      ...options.target,
      ...(phase === "adoption" ? { phase } : {}),
      at,
      expiresAt: at + 60_000,
    });
    return bounded(
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
  };
  return {
    close,
    adoption: async (signal: AbortSignal) => {
      const response = await request(signal, "adoption");
      if (!response.ok && response.status !== 503) {
        await bounded(response.body?.cancel() ?? Promise.resolve(), signal);
        throw new ReadinessResponseError(response.status);
      }
      const body: unknown = await bounded(response.json(), signal);
      if (!response.ok) {
        if (
          typeof body === "object" &&
          body !== null &&
          "outcome" in body &&
          body.outcome === "adopting" &&
          "observed" in body
        )
          return { adopted: false, observed: decodeRuntimeIdentity(body.observed) };
        throw new ReadinessResponseError(response.status);
      }
      const identity = decodeRuntimeIdentity(body);
      if (!sameRuntimeTarget(identity, options.target))
        throw new Error("Deployment code identity does not match the target");
      return { adopted: true, observed: identity };
    },
    ready: async (signal: AbortSignal) => {
      const response = await request(signal, "runtime");
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
