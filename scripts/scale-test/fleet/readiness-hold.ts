import { Schema } from "effect";
import {
  policyHealthHeader,
  launchGenerationHeader,
  launchTokenHashHeader,
} from "../../../src/pool/runtime-health.ts";

const Scope = Schema.Struct({
  runtimeName: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/u)),
  attempt: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/u)),
});
export type ReadinessScope = typeof Scope.Type;
const Ready = Schema.Struct({ boot_id: Schema.NonEmptyString, started_at: Schema.NonEmptyString });
interface Port {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}
interface Container {
  getTcpPort(port: number): Port;
}
export interface RealReadyObservation extends ReadinessScope {
  at: number;
  disposition: "held" | "released" | "expired" | "closed";
  status: number;
  body: string;
  positive: boolean;
  bootId?: string;
  startedAt?: string;
  generation?: number;
  tokenHash?: string;
  leaseMs?: number;
}

/** Stage plumbing suppresses positive real observations. It never invents readiness or changes Home. */
export function readinessHold(
  input: ReadinessScope & { deadline: number },
  options: {
    now?: () => number;
    record(observation: RealReadyObservation): void;
  },
) {
  const scope = Object.freeze(
    Schema.decodeUnknownSync(Scope)({ runtimeName: input.runtimeName, attempt: input.attempt }),
  );
  const deadline = input.deadline;
  const now = options.now ?? Date.now;
  const armedAt = now();
  if (
    !Number.isSafeInteger(armedAt) ||
    !Number.isSafeInteger(deadline) ||
    deadline <= armedAt ||
    deadline > armedAt + 120_000
  )
    throw new Error("Readiness hold must fit inside the unchanged startup budget");
  let disposition: RealReadyObservation["disposition"] = "held";
  let identity:
    | Pick<RealReadyObservation, "bootId" | "startedAt" | "generation" | "tokenHash">
    | undefined;
  let positives = 0;
  const current = () => {
    if (disposition === "held" && now() >= deadline) disposition = "expired";
    return disposition;
  };
  const assertScope = (value: ReadinessScope) => {
    if (value.runtimeName !== scope.runtimeName || value.attempt !== scope.attempt)
      throw new Error("Readiness hold belongs to another scratch runtime or attempt");
  };
  const port = (real: Port): Port => ({
    fetch: async (request, init) => {
      const response = await real.fetch(request, init);
      const actual = new Request(request, init);
      if (
        disposition === "closed" ||
        actual.method !== "GET" ||
        new URL(actual.url).pathname !== "/ready"
      )
        return response;
      const body = await response.clone().text();
      if (body.length > 1024) throw new Error("Real readiness body exceeds its contract");
      if (response.status !== 200) {
        options.record({
          ...scope,
          at: now(),
          disposition: current(),
          positive: false,
          status: response.status,
          body,
        });
        return response;
      }
      const parsed = Schema.decodeUnknownSync(Ready, { onExcessProperty: "error" })(
        JSON.parse(body),
      );
      const lease = response.headers.get(policyHealthHeader) ?? "";
      const generation = response.headers.get(launchGenerationHeader) ?? "";
      const tokenHash = response.headers.get(launchTokenHashHeader) ?? "";
      if (
        !/^[1-9]\d*$/u.test(lease) ||
        Number(lease) > 1500 ||
        !/^[1-9]\d*$/u.test(generation) ||
        !Number.isSafeInteger(Number(generation)) ||
        !/^[a-f0-9]{64}$/u.test(tokenHash)
      )
        throw new Error(
          "Real readiness observation lacks a positive native lease and launch witness",
        );
      const observed = {
        bootId: parsed.boot_id,
        startedAt: parsed.started_at,
        generation: Number(generation),
        tokenHash,
      };
      if (identity && JSON.stringify(identity) !== JSON.stringify(observed))
        throw new Error("Readiness hold observed a changed runtime incarnation");
      identity ??= observed;
      positives++;
      const status = current();
      options.record({
        ...scope,
        at: now(),
        disposition: status,
        positive: true,
        status: response.status,
        body,
        ...observed,
        leaseMs: Number(lease),
      });
      if (status !== "held") return response;
      await response.body?.cancel();
      return new Response(null, { status: 503 });
    },
  });
  return {
    scope,
    wrapContext<T extends { container?: Container }>(ctx: T): T {
      if (!ctx.container) throw new Error("Readiness hold requires a real container adapter");
      const real = ctx.container;
      const container = new Proxy(real, {
        get(target, key) {
          if (key === "getTcpPort")
            return (number: number) =>
              number === 8318 ? port(real.getTcpPort(number)) : real.getTcpPort(number);
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return new Proxy(ctx, {
        get(target, key) {
          if (key === "container") return container;
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    inspect(value: ReadinessScope) {
      assertScope(value);
      return { ...scope, armedAt, deadline: deadline, disposition: current(), positives, identity };
    },
    release(value: ReadinessScope) {
      assertScope(value);
      if (current() !== "held" || !positives)
        throw new Error("Only a positively observed, unexpired hold can release");
      disposition = "released";
    },
    close() {
      disposition = "closed";
    },
  };
}
