import { Schema } from "effect";
import { openEnvelope } from "../../src/pool/token.ts";
import { deploymentReadinessPath } from "../../src/pool/deployment-readiness.ts";
import {
  decodeRuntimeHandoffCommand,
  runtimeHandoffCommandPrefix,
  runtimeHandoffPath,
} from "../../src/pool/runtime-slots/handoff-command.ts";
import { runtimeRecoveryPath } from "../../src/pool/runtime-recovery.ts";
import { readFile } from "node:fs/promises";
import { nodePoolOperations } from "../pool-operations-node.ts";
import { openPoolOperations, type PoolOperationsTarget } from "../pool-operations.ts";
import { BarrierRefusal } from "./refusal.ts";
import type { RuntimeReleaseWriter } from "./runtime-release-writer.ts";

type Connect = NonNullable<PoolOperationsTarget["connect"]>;

/** The handoff actions the preflight sends. Each one only reads controller or provider state. */
export const preflightReadActions = new Set([
  "inspect",
  "active-health",
  "fleet-inspect",
  "witness",
  "provider-observe",
]);

/**
 * One active-health read as health() counts it: from dispatch over the open bridge until the
 * call returns, which includes reading the reply and closing the bridge.
 */
export type HealthTiming = {
  leaseMs: number | null;
  requestLegMs: number;
  closeMs: number | null;
  marginMs: number | null;
  /** Bridge startup before dispatch; the pre-fix health() counted it, so this margin also subtracts it. */
  setupMs: number;
  setupInclusiveMarginMs: number | null;
};

export type PreflightBridgeCounters = {
  dispatched: Record<string, number>;
  refused: Record<string, number>;
  health: HealthTiming[];
};

export const createPreflightBridgeCounters = (): PreflightBridgeCounters => ({
  dispatched: {},
  refused: {},
  health: [],
});

const Lease = Schema.Struct({ result: Schema.Struct({ leaseMs: Schema.Number }) });

async function grantedLease(response: Response) {
  try {
    return Schema.decodeUnknownSync(Lease)(await response.clone().json()).result.leaseMs;
  } catch {
    return null;
  }
}

const round = (value: number) => Math.round(value * 10) / 10;

const Envelope = Schema.Struct({ envelope: Schema.String });

async function signedPayload(request: Request, key: string) {
  try {
    const body = Schema.decodeUnknownSync(Envelope)(await request.clone().json());
    const payload = await openEnvelope(key, runtimeHandoffCommandPrefix, body.envelope);
    return typeof payload === "object" && payload !== null ? payload : undefined;
  } catch {
    return undefined;
  }
}

/** Classifies one bridge request; anything that is not a known read is a mutation. */
async function classify(request: Request, key: string) {
  const url = new URL(request.url);
  if (url.search) return "unknown-request";
  if (request.method === "GET" && url.pathname === runtimeRecoveryPath && !request.body)
    return "recovery-health";
  if (request.method !== "POST") return "unknown-request";
  if (url.pathname === runtimeHandoffPath) {
    const payload = await signedPayload(request, key);
    if (!payload) return "unsigned-command";
    let action: string;
    try {
      // The release's own strict decode: closed fields, a known action and an unexpired window.
      action = decodeRuntimeHandoffCommand(payload).action;
    } catch {
      return "invalid-command";
    }
    return preflightReadActions.has(action) ? action : `mutation:${action}`;
  }
  if (url.pathname === deploymentReadinessPath) {
    const payload = await signedPayload(request, key);
    if (!payload) return "unsigned-readiness";
    // The adoption phase can restart a runtime onto new code; only the plain runtime read passes.
    return Reflect.get(payload, "phase") === undefined
      ? "readiness-runtime"
      : "mutation:readiness-adoption";
  }
  return "unknown-request";
}

/** Wraps the PoolOperations bridge so every non-read request is refused before it is sent. */
export function readOnlyPoolOperations(
  connect: Connect,
  key: string,
  counters: PreflightBridgeCounters,
): Connect {
  return async (path) => {
    const opened = performance.now();
    const platform = await connect(path);
    const setupMs = round(performance.now() - opened);
    const service = platform.env.POOL_OPERATIONS;
    let health: HealthTiming | undefined;
    return {
      ...platform,
      dispose: async () => {
        const start = performance.now();
        try {
          await platform.dispose();
        } finally {
          if (health) {
            health.closeMs = round(performance.now() - start);
            if (health.leaseMs !== null) {
              health.marginMs = round(health.leaseMs - health.requestLegMs - health.closeMs);
              health.setupInclusiveMarginMs = round(health.marginMs - health.setupMs);
            }
          }
        }
      },
      env: {
        ...platform.env,
        POOL_OPERATIONS: {
          fetch: async (request: Request) => {
            const kind = await classify(request, key);
            const allowed =
              kind === "recovery-health" ||
              kind === "readiness-runtime" ||
              preflightReadActions.has(kind);
            const counter = allowed ? counters.dispatched : counters.refused;
            counter[kind] = (counter[kind] ?? 0) + 1;
            if (!allowed)
              throw new BarrierRefusal("release-preflight-mutation-refused", `bridge.${kind}`);
            if (kind !== "active-health") return service.fetch(request);
            // Classification ran first, so the leg times only what the release itself sends.
            const start = performance.now();
            let leaseMs: number | null = null;
            try {
              const response = await service.fetch(request);
              leaseMs = await grantedLease(response);
              return response;
            } finally {
              health = {
                leaseMs,
                requestLegMs: round(performance.now() - start),
                closeMs: null,
                marginMs: null,
                setupMs,
                setupInclusiveMarginMs: null,
              };
              counters.health.push(health);
            }
          },
        },
      },
    };
  };
}

/** A writer whose every write path refuses. Reads that only call assert() still run. */
export function readOnlyReleaseWriter(candidate: string): RuntimeReleaseWriter {
  const refuse = (path: string): never => {
    throw new BarrierRefusal("release-preflight-mutation-refused", path);
  };
  return {
    candidate,
    lease: "release-preflight:read-only",
    assert: () => {},
    enable: () => refuse("writer.enable"),
    exclusive: async () => refuse("writer.exclusive"),
  };
}

const BridgeConfig = Schema.Struct({
  account_id: Schema.String,
  services: Schema.Array(
    Schema.Struct({
      binding: Schema.Literal("POOL_OPERATIONS"),
      service: Schema.String,
      entrypoint: Schema.Literal("PoolOperations"),
      remote: Schema.Literal(true),
    }),
  ),
});

/** The same Node bridge the release opens per command, so its setup and close cost count too. */
export const nodeBridgeFromConfig: Connect = async (path) => {
  const config = Schema.decodeUnknownSync(BridgeConfig, { onExcessProperty: "ignore" })(
    JSON.parse(await readFile(path, "utf8")),
  );
  if (config.services.length !== 1)
    throw new BarrierRefusal("release-preflight-bridge-target-refused", "PoolWorker");
  return nodePoolOperations(config.account_id, config.services[0]!.service);
};

/** The unsigned recovery GET reports the release the controller process is running. */
export async function runningRelease(target: PoolOperationsTarget) {
  const bridge = await openPoolOperations(target);
  try {
    const response = await bridge.service.fetch(
      new Request(`http://pool-operations${runtimeRecoveryPath}`, {
        signal: AbortSignal.timeout(15_000),
      }),
    );
    if (response.status !== 200) {
      await response.body?.cancel();
      return undefined;
    }
    const { release } = Schema.decodeUnknownSync(
      Schema.Struct({ release: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)) }),
      { onExcessProperty: "ignore" },
    )(await response.json());
    return release;
  } catch {
    return undefined;
  } finally {
    await bridge.close();
  }
}
