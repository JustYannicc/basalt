import type { TunnelOpen } from "../../clients/contracts/tunnel.ts";

type SessionStage = "start" | "access" | "lease" | "ready" | "closed" | "refused" | "failed";
type OperationStage = "open" | "upload-end" | "dispatch" | "headers" | "response-end" | "stopped";
export type OperationTiming = (stage: OperationStage) => void;
type TimingEvent = {
  tunnel: string;
  stage: SessionStage | OperationStage;
  elapsedMs: number;
  id?: number;
  service?: "models" | "tools";
  transport?: "http" | "websocket";
  operationMs?: number;
};

/** Fixed admission and operation budgets keep long-lived sockets from producing unbounded logs. */
export function createTunnelTimingSampler(
  now = Date.now,
  write = (event: TimingEvent) => console.info("NATIVE_TUNNEL_TIMING " + JSON.stringify(event)),
) {
  let windowStart = now();
  let sessions = 0;
  return () => {
    const start = now();
    if (start - windowStart >= 60_000) {
      windowStart = start;
      sessions = 0;
    }
    if (sessions >= 4) return undefined;
    sessions++;
    const tunnel = crypto.randomUUID();
    const stages = new Set<SessionStage>();
    let operations = 0;
    const emit = (event: Omit<TimingEvent, "tunnel" | "elapsedMs">) => {
      try {
        write({ tunnel, elapsedMs: Math.max(0, now() - start), ...event });
      } catch {
        // Diagnostics must never change dispatch or cancellation behavior.
      }
    };
    return {
      mark(stage: SessionStage) {
        if (stages.has(stage)) return;
        stages.add(stage);
        emit({ stage });
      },
      operation(open: TunnelOpen): OperationTiming | undefined {
        if (operations >= 8) return undefined;
        operations++;
        const started = now();
        const {
          id,
          operation: { service, transport },
        } = open;
        const seen = new Set<OperationStage>();
        return (stage) => {
          if (seen.has(stage)) return;
          seen.add(stage);
          emit({
            stage,
            id,
            service,
            transport,
            operationMs: Math.max(0, now() - started),
          });
        };
      },
    };
  };
}

export type TunnelTiming = NonNullable<ReturnType<ReturnType<typeof createTunnelTimingSampler>>>;
export const sampleTunnelTiming = createTunnelTimingSampler();
