import { createHash, randomUUID } from "node:crypto";
import { signEnvelope } from "../../src/pool/token.ts";

export const acceptancePoolPath = "/api/internal/acceptance-pool";

/** The server's closed refusal words; anything else a response says is reported as `unknown`. */
const reasons = new Set([
  "request_invalid",
  "unauthenticated",
  "name_pattern",
  "checksum_mismatch",
  "go_mismatch",
  "stale_plan",
  "replayed",
  "operation_busy",
  "receipt_mismatch",
  "receipt_full",
  "setup_missing",
  "upstream_unset",
  "upstream_differs",
  "upstream_key_invalid",
  "identity_conflict",
  "identity_holds_pool",
  "unrecorded_app",
  "unrecorded_link",
  "unrecorded_account",
  "pool_state",
  "verification_failed",
  "step_failed",
  "failed",
]);
const stepName = /^[a-z0-9][a-z0-9:-]{0,63}$/u;

export interface AcceptanceFailure {
  readonly format: "basalt-acceptance-pool-failure-v1";
  readonly reason: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly step?: string;
}
export class AcceptanceRefusal extends Error {
  readonly failure: AcceptanceFailure;
  constructor(failure: AcceptanceFailure) {
    super(`Acceptance pool operation refused: ${failure.reason}`);
    this.failure = failure;
  }
}
const refused = (reason: string, extra: Partial<AcceptanceFailure> = {}) =>
  new AcceptanceRefusal({
    format: "basalt-acceptance-pool-failure-v1",
    reason,
    retryable: false,
    ...extra,
  });

export interface AcceptanceInput {
  readonly target: string;
  readonly signingKey: string;
  readonly kind: string;
  readonly action: string;
  readonly request: string;
  readonly recipient: string;
  readonly planSha256: string;
  readonly go: string;
  /** The emulated upstream's origin, as the workflow holds it; only its digest is sent. */
  readonly upstreamOrigin?: string;
  /** Only for a setup apply. */
  readonly upstreamKey?: string;
  /** The saved result of the dry run an apply names. */
  readonly previous?: unknown;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The digest the server compares with its own: it never learns the origin from a request. */
export function upstreamOriginSha256(value: string): string {
  const url = URL.parse(value);
  if (
    url === null ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw refused("upstream_origin_invalid");
  return createHash("sha256")
    .update(`basalt-acceptance-upstream-origin-v1\n${url.origin}`)
    .digest("hex");
}

export async function acceptanceOperation(
  input: AcceptanceInput,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const target = URL.parse(input.target);
  // https only; plain http only to 127.0.0.1, where the tests' local server stands in for the
  // tools service (the load job's driver makes the same exception).
  const loopback = target?.protocol === "http:" && target.hostname === "127.0.0.1";
  if (
    target === null ||
    target.origin !== input.target ||
    (target.protocol !== "https:" && !loopback)
  )
    throw refused("config");
  if (!/^[a-f0-9]{64}$/iu.test(input.signingKey)) throw refused("config");
  if (!["setup", "teardown"].includes(input.kind)) throw refused("config");
  if (!["dry-run", "apply", "verify"].includes(input.action)) throw refused("config");
  if (Buffer.byteLength(input.request) > 16_384) throw refused("request_invalid");
  let request: unknown;
  try {
    request = JSON.parse(input.request);
  } catch {
    throw refused("request_invalid");
  }
  if (!record(request)) throw refused("request_invalid");
  const operation: Record<string, unknown> = {
    kind: input.kind,
    action: input.action,
    request,
  };
  if (input.kind === "setup" && input.action !== "verify") {
    if (input.upstreamOrigin === undefined || input.upstreamOrigin === "")
      throw refused("upstream_origin_missing");
    operation.upstreamOriginSha256 = upstreamOriginSha256(input.upstreamOrigin);
  }
  if (input.action === "dry-run") {
    if (input.recipient.length > 2048 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(input.recipient))
      throw refused("config");
    operation.recipient = input.recipient;
  }
  if (input.action === "verify") {
    if (!/^[a-f0-9]{64}$/u.test(input.planSha256)) throw refused("config");
    operation.planSha256 = input.planSha256;
  }
  if (input.action === "apply") {
    const previous = input.previous;
    if (
      !record(previous) ||
      previous.action !== "dry-run" ||
      previous.kind !== input.kind ||
      !record(previous.artifact) ||
      !/^[a-f0-9]{64}$/u.test(input.planSha256) ||
      previous.artifact.sha256 !== input.planSha256 ||
      previous.planSha256 !== input.planSha256 ||
      input.go !== `GO ${input.planSha256}`
    )
      throw refused("config");
    Object.assign(operation, {
      artifact: previous.artifact,
      planSha256: input.planSha256,
      go: input.go,
    });
    if (input.kind === "setup") {
      if (input.upstreamKey === undefined || input.upstreamKey === "")
        throw refused("upstream_key_missing");
      operation.upstreamKey = input.upstreamKey;
    }
  }
  const at = Date.now();
  const envelope = await signEnvelope(input.signingKey, "sbacc1", {
    version: 1,
    id: randomUUID(),
    target: target.origin,
    at,
    expiresAt: at + 60_000,
    operation,
  }).catch(() => {
    throw refused("config");
  });
  const response = await fetcher(`${target.origin}${acceptancePoolPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ envelope }),
    redirect: "error",
    // Longer than the server's own bound on one request, so the server ends it first.
    signal: AbortSignal.timeout(290_000),
  }).catch(() => {
    throw refused("unreachable", { retryable: true });
  });
  const text = await readBounded(response, response.ok ? 1_000_000 : 4096).catch(() => {
    throw refused("decode", { httpStatus: response.status });
  });
  let result: unknown;
  try {
    result = JSON.parse(text);
  } catch {
    throw refused("decode", { httpStatus: response.status });
  }
  if (!response.ok) {
    const said = record(result) ? result : {};
    const reason =
      typeof said.reason === "string" && reasons.has(said.reason) ? said.reason : "unknown";
    throw refused(reason, {
      httpStatus: response.status,
      retryable: reason === "operation_busy",
      ...(typeof said.step === "string" && stepName.test(said.step) ? { step: said.step } : {}),
    });
  }
  if (!record(result) || result.action !== input.action || result.kind !== input.kind)
    throw refused("decode", { httpStatus: response.status });
  return result;
}

async function readBounded(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Response exceeds its bound");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
