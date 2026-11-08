import { BarrierRefusal } from "./refusal.ts";
import { safeProviderFailure } from "./operation-failure.ts";

export type ServingCheck =
  | "bridge-open"
  | "instance-start"
  | "application-image"
  | "instance-image"
  | "deployment-readiness"
  | "runtime-health"
  | "boot-identity"
  | "unsigned-health"
  | "unsigned-model-auth"
  | "bridge-close";

export interface ServingObservation {
  version: number;
  activeRolloutId?: string;
  digest: string | null;
  instances: {
    id: string;
    state: string;
    digest: string | null;
    startedAt: number | null;
  }[];
}

export interface ServingDiagnostic {
  check: ServingCheck;
  cause: string;
  status?: number;
  expectedStatus?: number;
  elapsedMs?: number;
  observation?: ServingObservation;
}

export class ServingFailure extends BarrierRefusal {
  readonly serving: ServingDiagnostic;
  constructor(serving: ServingDiagnostic) {
    super("container-serving-not-verified", "PoolContainer");
    this.serving = serving;
  }
}

export function servingFailure(check: ServingCheck, error: unknown): ServingFailure {
  if (error instanceof ServingFailure) return error;
  const provider = safeProviderFailure(error);
  const name = error instanceof Error ? error.name : undefined;
  return new ServingFailure({
    check,
    cause: name === "AbortError" || name === "TimeoutError" ? name : provider.type,
    ...(provider.status === undefined ? {} : { status: provider.status }),
  });
}
