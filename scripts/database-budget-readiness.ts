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
import type { ReadinessRefusal } from "./database-budget-receipt.ts";

export class ReadinessResponseError extends Error {
  override readonly name = "ResponseError";
  readonly status: number;
  /** The server's fixed refusal vocabulary, so a 503 says which readiness stage failed. */
  readonly outcome: string | undefined;
  readonly stage: string | undefined;
  constructor(status: number, detail: { outcome?: string; stage?: string } = {}) {
    super("Deployment runtime readiness failed");
    this.status = status;
    this.outcome = detail.outcome;
    this.stage = detail.stage;
  }
}

const closedWord = (value: unknown) =>
  typeof value === "string" && /^[a-z-]{1,40}$/u.test(value) ? value : undefined;

/** Keeps only the fixed outcome and stage of a small refusal body; anything else is dropped. */
async function readinessRefusal(response: Response, signal: AbortSignal) {
  try {
    const text = await bounded(response.text(), signal);
    if (text.length > 512) return {};
    const body: unknown = JSON.parse(text);
    if (typeof body !== "object" || body === null) return {};
    const outcome = closedWord(Reflect.get(body, "outcome"));
    const stage = closedWord(Reflect.get(body, "stage"));
    return { ...(outcome ? { outcome } : {}), ...(stage ? { stage } : {}) };
  } catch {
    return {};
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
      if (!response.ok)
        throw new ReadinessResponseError(response.status, await readinessRefusal(response, signal));
      return decodeRuntimeReady(await bounded(response.json(), signal), options.target);
    },
  };
}

export const readinessRetryMs = 5_000;
type Readiness = Awaited<ReturnType<typeof openDeploymentReadiness>>;

/**
 * Refusals that pass by themselves while an upload settles: 409 from an entrypoint still on the
 * previous version, 503 from one whose controller object still is, and 429 or any other 5xx from
 * the platform in between. The release layer's identity check asks again on the same 5xx and 429.
 */
const settles = (status: number) => status === 409 || status === 429 || status >= 500;

/**
 * Asks for runtime readiness until it is granted or the caller's deadline ends.
 *
 * After an upload the new entrypoint answers at once, but the platform may keep an active
 * controller object on its previous code for up to 300 seconds. Until the object adopts the new
 * code its identity does not match, so readiness is refused although nothing is wrong. A deadline
 * that ends a pause fails with the last refusal. A call still in flight at the deadline ends as
 * an abort, as a stalled call always has.
 */
export async function readyAfterAdoption(
  connection: Pick<Readiness, "ready"> & Partial<Pick<Readiness, "adoption">>,
  target: Pick<RuntimeReady, "candidate">,
  options: {
    signal: AbortSignal;
    pause: (signal: AbortSignal) => Promise<void>;
    refused: (refusal: ReadinessRefusal) => void;
  },
): Promise<RuntimeReady> {
  const { signal } = options;
  let observed: Pick<ReadinessRefusal, "adopted" | "candidateMatches"> = {};
  for (;;) {
    const answer = await bounded(connection.ready(signal), signal).catch((error: unknown) => {
      if (error instanceof ReadinessResponseError && settles(error.status)) return error;
      throw error;
    });
    if (!(answer instanceof ReadinessResponseError)) return answer;
    // Says which side refused: an object still on the old code, or the runtime behind a new one.
    // One slow answer may not use up the wait, so it gets no longer than a pause.
    const adoption = connection.adoption
      ? await withinDeadline(connection.adoption(signal), readinessRetryMs).catch(() => undefined)
      : undefined;
    if (adoption)
      observed = {
        adopted: adoption.adopted,
        candidateMatches: adoption.observed.candidate === target.candidate,
      };
    // A deadline that cuts the check short leaves its previous answer on the record.
    else if (!signal.aborted) observed = {};
    options.refused({
      status: answer.status,
      ...(answer.outcome ? { outcome: answer.outcome } : {}),
      ...(answer.stage ? { stage: answer.stage } : {}),
      ...observed,
    });
    try {
      await options.pause(signal);
    } catch {
      throw answer;
    }
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

/** A pause between attempts that the caller's deadline cuts short. */
export async function pause(milliseconds: number, signal: AbortSignal, schedule = liveDeadline) {
  const elapsed = schedule(milliseconds);
  try {
    await bounded(
      new Promise<void>((resolve) => {
        if (elapsed.signal.aborted) resolve();
        else elapsed.signal.addEventListener("abort", () => resolve(), { once: true });
      }),
      signal,
    );
  } finally {
    elapsed.dispose();
  }
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
