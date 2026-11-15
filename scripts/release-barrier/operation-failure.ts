import { StateStoreError } from "alchemy/State/State";
import { Cause, Effect } from "effect";
import { BarrierRefusal } from "./refusal.ts";
import { migrationCommandFailure, type MigrationDiagnostic } from "./migration-failure.ts";

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
  // Wrangler 4.153.0's UserError subclasses can inherit Error.name unchanged.
  "UserError",
  "FatalError",
  "CommandLineArgsError",
  "MissingConfigError",
  "ParseError",
  "APIError",
  "RemoteSessionAuthenticationError",
  "MiniflareCoreError",
  "MiniflareError",
  "AggregateError",
]);

const nodeCodes = new Set([
  "MODULE_NOT_FOUND",
  "ERR_MODULE_NOT_FOUND",
  "ERR_REQUIRE_ESM",
  "ERR_DLOPEN_FAILED",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const httpReasons = new Set([
  "TransportError",
  "EncodeError",
  "InvalidUrlError",
  "StatusCodeError",
  "DecodeError",
  "EmptyBodyError",
]);

const field = (value: unknown, key: string): unknown => {
  try {
    return (typeof value === "object" || typeof value === "function") && value !== null
      ? Reflect.get(value, key)
      : undefined;
  } catch {
    return undefined;
  }
};
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;

export interface ProviderFailure {
  type: string;
  reason?: string;
  status?: number;
  codes?: number[];
  nodeCode?: string;
  exitCode?: number | null;
  migration?: MigrationDiagnostic;
}

/** Provider messages, bodies, URLs and stacks can contain credentials. Copy only closed diagnostics. */
export function safeProviderFailure(error: unknown): ProviderFailure {
  let migration;
  try {
    migration = migrationCommandFailure(error);
  } catch {
    // A hostile getter is not a diagnostic and must not replace the original refusal.
  }
  if (migration) return migration;
  const constructor = field(field(error, "constructor"), "name");
  const name = field(error, "name");
  const tag =
    field(error, "_tag") ??
    (name === "Error" && typeof constructor === "string" && knownTypes.has(constructor)
      ? constructor
      : name);
  const type = typeof tag === "string" && knownTypes.has(tag) ? tag : "unknown";
  const httpReason = type === "HttpClientError" ? field(error, "reason") : undefined;
  const reason = field(httpReason, "_tag");
  const status =
    field(error, "status") ??
    field(field(httpReason, "response"), "status") ??
    (type === "StateStoreError" ? field(field(error, "http"), "status") : undefined);
  const entries = field(error, "errors");
  const nodeCode = field(error, "code");
  const codes = [
    ...new Set(
      [
        field(error, "code"),
        ...(Array.isArray(entries) ? entries.slice(0, 8).map((entry) => field(entry, "code")) : []),
      ].filter((code) => integer(code, 0, 2_147_483_647)),
    ),
  ]
    .sort((a, b) => a - b)
    .slice(0, 8);
  return {
    type,
    ...(typeof reason === "string" && httpReasons.has(reason) ? { reason } : {}),
    ...(integer(status, 100, 599) ? { status } : {}),
    ...(codes.length ? { codes } : {}),
    ...(typeof nodeCode === "string" && nodeCodes.has(nodeCode) ? { nodeCode } : {}),
  };
}

/** Connection wrappers often retain the useful API or network failure only in cause. */
export function safeProviderFailureChain(error: unknown): ProviderFailure[] {
  const result: ProviderFailure[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && result.length < 4 && !seen.has(current)) {
    seen.add(current);
    result.push(safeProviderFailure(current));
    current = field(current, "cause");
  }
  return result;
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
