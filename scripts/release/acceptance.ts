import { PoolAcceptanceClient } from "../pool-acceptance/client.ts";

/**
 * The release's own acceptance through the public pool: one warm-up, a concurrent burst, one final
 * request, all streamed. Any failed request fails the release (an intermittent error is a stop).
 * Each response names the runtime that served it (X-Signalbox-Pool-Boot), so a release can also
 * require that the root kept its boot (code-only) or that a fleet cell served (fleet).
 */
export interface AcceptanceOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly burst?: number;
  readonly expect: "same-boot" | "two-runtimes" | "any";
  /** The root's boot read before the apply: no release may restart the root, whatever it serves. */
  readonly rootBoot?: string;
  readonly client?: PoolAcceptanceClient;
}

/** The boot of the runtime serving the pool now: the root while no fleet cell serves. */
export async function servingBoot(apiKey: string, client = new PoolAcceptanceClient()) {
  return (await client.modelCatalog(apiKey)).boot;
}

export interface AcceptanceResult {
  readonly passed: boolean;
  readonly requests: number;
  readonly failures: readonly string[];
  readonly boots: readonly string[];
  readonly firstByteMs: { readonly p50: number; readonly p95: number };
  readonly cause?: string;
}

const percentile = (values: number[], fraction: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!);
};

export async function runAcceptance(options: AcceptanceOptions): Promise<AcceptanceResult> {
  const client = options.client ?? new PoolAcceptanceClient();
  const catalog = await client.modelCatalog(options.apiKey);
  const model = options.model ?? catalog.ids[0];
  if (!model || !catalog.ids.includes(model))
    throw new Error("The acceptance model is not in /v1/models");
  const failures: string[] = [];
  const boots: string[] = [catalog.boot];
  const timings: number[] = [];
  const turn = async () => {
    try {
      const result = await client.sendTurn(options.apiKey, model, {
        id: crypto.randomUUID().toLowerCase(),
        expectedRecords: 1,
      });
      boots.push(result.boot);
      timings.push(result.firstByteMs);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  };
  await turn();
  await Promise.all(Array.from({ length: options.burst ?? 25 }, turn));
  await turn();
  const distinct = [...new Set(boots)];
  const cause = failures.length
    ? `${failures.length} of ${(options.burst ?? 25) + 2} requests failed: ${[...new Set(failures)].join("; ")}`
    : options.rootBoot !== undefined &&
        (!distinct.includes(options.rootBoot) ||
          (options.expect === "same-boot" && distinct.length !== 1))
      ? `The root restarted: boot ${options.rootBoot} before the apply, ${distinct.join(", ")} after`
      : options.expect === "same-boot" && distinct.length !== 1
        ? `The root changed boot during acceptance (${distinct.length} boots)`
        : options.expect === "two-runtimes" && distinct.length < 2
          ? "Every request was served by one runtime; no fleet cell served"
          : undefined;
  return {
    passed: cause === undefined,
    requests: (options.burst ?? 25) + 2,
    failures,
    boots: distinct,
    firstByteMs: { p50: percentile(timings, 0.5), p95: percentile(timings, 0.95) },
    ...(cause ? { cause } : {}),
  };
}
