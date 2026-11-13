import { StateStoreError } from "alchemy/State/State";
import { Cause, Effect } from "effect";
import { BarrierRefusal } from "./refusal.ts";

export type ReleaseOperation =
  | "plan-read-state"
  | "apply-read-state"
  | "apply-write-state"
  | "read-release-journal"
  | "write-release-journal"
  | "record-release-journal"
  | "plan-stack"
  | "plan-read-resource"
  | "plan-diff-resource"
  | "prepare-resource"
  | "read-worker-baseline"
  | "freeze-worker-upload"
  | "read-class-expansion"
  | "deploy-class-expansion"
  | "stage-class-baseline-clone"
  | "record-class-expansion"
  | "check-source-namespace"
  | "read-native-state"
  | "verify-native-state"
  | "check-declared-buckets"
  | "check-declared-databases"
  | "apply-database-resource"
  | "apply-database-plan"
  | "before-activation"
  | "release-stack";

export const knownTypes = new Set([
  // Effect's own timeout, raised by a provider call's bounded wait.
  "TimeoutError",
  "StateStoreError",
  "CloudflareHttpError",
  "CloudflareParseError",
  "UnknownCloudflareError",
  "CloudflareError",
  "CloudflareRateLimited",
  "InvalidRoute",
  // A declared bucket removed between the reads that observe it.
  "NoSuchBucket",
  "WorkerNotFound",
  "WorkerVersionNotFound",
  "BadRequest",
  "Unauthorized",
  "Forbidden",
  "NotFound",
  "Conflict",
  "UnprocessableEntity",
  "Locked",
  "TooManyRequests",
  "InternalServerError",
  "BadGateway",
  "ServiceUnavailable",
  "GatewayTimeout",
  "ConfigError",
  "RequestError",
  "ResponseError",
  "HttpClientError",
  "SchemaError",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "Error",
]);

const httpReasons = new Set([
  "TransportError",
  "EncodeError",
  "InvalidUrlError",
  "StatusCodeError",
  "DecodeError",
  "EmptyBodyError",
]);

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;

/** Provider messages, bodies, URLs and stacks can contain credentials. Copy only closed types and numeric diagnostics. */
export function safeProviderFailure(error: unknown) {
  const tag = field(error, "_tag") ?? field(error, "name");
  const type = typeof tag === "string" && knownTypes.has(tag) ? tag : "unknown";
  const httpReason = type === "HttpClientError" ? field(error, "reason") : undefined;
  const reason = field(httpReason, "_tag");
  const status =
    field(error, "status") ??
    field(field(httpReason, "response"), "status") ??
    (type === "StateStoreError" ? field(field(error, "http"), "status") : undefined);
  const entries = field(error, "errors");
  const codes = [
    ...new Set(
      [
        field(error, "code"),
        ...(Array.isArray(entries) ? entries.slice(0, 8).map((entry) => field(entry, "code")) : []),
      ].filter((code) => integer(code, 0, 2_147_483_647)),
    ),
  ].sort((a, b) => a - b);
  return {
    type,
    ...(typeof reason === "string" && httpReasons.has(reason) ? { reason } : {}),
    ...(integer(status, 100, 599) ? { status } : {}),
    ...(codes.length ? { codes } : {}),
  };
}

export class ReleaseOperationFailure extends BarrierRefusal {
  readonly operation: ReleaseOperation;
  readonly provider: ReturnType<typeof safeProviderFailure> | undefined;

  constructor(error: unknown, resource: string, operation: ReleaseOperation) {
    const refusal = error instanceof BarrierRefusal ? error : undefined;
    super(
      refusal?.reason ?? "release-operation-failed",
      refusal?.worker ?? resource,
      refusal?.delta && !refusal.worker ? { ...refusal.delta, fqn: resource } : refusal?.delta,
      refusal?.refusals,
      refusal?.stateStore,
    );
    this.operation = operation;
    this.provider = refusal ? undefined : safeProviderFailure(error);
  }
}

/** Preserve State's declared error channel while carrying the sanitized release diagnostic. */
export class ReleaseStateStoreFailure extends StateStoreError {
  readonly failure: ReleaseOperationFailure;
  constructor(error: StateStoreError, resource: string, operation: ReleaseOperation) {
    super({
      message: "Release State operation failed",
      ...(error.http ? { http: error.http } : {}),
    });
    this.failure =
      error instanceof ReleaseStateStoreFailure
        ? error.failure
        : new ReleaseOperationFailure(error, resource, operation);
  }
}

export const operationFailure = (error: unknown, resource: string, operation: ReleaseOperation) =>
  error instanceof ReleaseStateStoreFailure
    ? error.failure
    : error instanceof ReleaseOperationFailure
      ? error
      : new ReleaseOperationFailure(error, resource, operation);

export const withOperation =
  (resource: string, operation: ReleaseOperation) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause): Effect.Effect<never, E | ReleaseOperationFailure> =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.fail(operationFailure(Cause.squash(cause), resource, operation)),
      ),
    );
