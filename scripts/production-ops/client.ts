import { randomUUID } from "node:crypto";
import { signEnvelope } from "../../src/pool/token.ts";
import { canonical, hash } from "./artifact.ts";
import { failure, failureReceipt, OperationFailure } from "./failure.ts";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface OpsInput {
  readonly target: string;
  readonly signingKey: string;
  readonly action: string;
  readonly selection: string;
  readonly mode: string;
  readonly request: string;
  readonly recipient: string;
  readonly planSha256: string;
  readonly go: string;
  readonly previous?: unknown;
}

export async function productionOperation(
  input: OpsInput,
  fetcher = fetch,
): Promise<Record<string, unknown>> {
  const target = new URL(input.target);
  if (target.origin !== input.target || target.protocol !== "https:")
    throw new OperationFailure(failure("config", "config"));
  if (
    !/^[a-f0-9]{64}$/i.test(input.signingKey) ||
    !/^[a-z0-9][a-z0-9-]{0,127}$/.test(input.selection)
  )
    throw new OperationFailure(failure("config", "config"));
  const action = input.action === "migrate" ? input.mode : input.action;
  if (!["inventory", "backup", "prepare", "dry-run", "apply"].includes(action))
    throw new OperationFailure(failure("config", "config"));
  if (input.recipient.length > 2048 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.recipient))
    throw new OperationFailure(failure("config", "config"));
  let request: unknown;
  try {
    request = JSON.parse(input.request);
  } catch {
    throw new OperationFailure(failure("decode", "decode"));
  }
  if (
    !record(request) ||
    typeof request.organization !== "string" ||
    request.organization.length === 0 ||
    request.organization.length > 256 ||
    Buffer.byteLength(input.request) > 500_000
  )
    throw new OperationFailure(failure("config", "config"));
  const operation: Record<string, unknown> = {
    action,
    selection: input.selection,
    request,
    recipient: input.recipient,
  };
  if (action === "apply") {
    const previous = input.previous;
    if (
      !record(previous) ||
      previous.action !== "dry-run" ||
      !record(previous.artifact) ||
      !record(previous.backup) ||
      !/^[a-f0-9]{64}$/.test(input.planSha256) ||
      previous.artifact.sha256 !== input.planSha256 ||
      input.go !== `GO ${input.planSha256}` ||
      hash(`${canonical(previous.backup)}\n`) !== previous.backupSha256
    )
      throw new OperationFailure(failure("config", "config"));
    Object.assign(operation, {
      artifact: previous.artifact,
      planSha256: input.planSha256,
      backupSha256: previous.backupSha256,
      go: input.go,
    });
  }
  const at = Date.now();
  const envelope = await signEnvelope(input.signingKey, "sbops1", {
    version: 1,
    id: randomUUID(),
    target: target.origin,
    at,
    expiresAt: at + 60_000,
    operation,
  }).catch(() => {
    throw new OperationFailure(failure("auth", "auth"));
  });
  const response = await fetcher(`${target.origin}/api/internal/production-ops`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ envelope }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  }).catch(() => {
    throw new OperationFailure(failure("unknown", "request"));
  });
  const refusal = () =>
    failure(
      response.status === 401 || response.status === 403
        ? "auth"
        : response.status === 503
          ? "config"
          : "unknown",
      "request",
      response.status,
    );
  if (!response.body) throw new OperationFailure(refusal());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read().catch(() => {
        throw new OperationFailure(failure("decode", "decode", response.status));
      });
      if (part.done) break;
      size += part.value.byteLength;
      if (size > (response.ok ? 48_000_000 : 4096)) {
        await reader.cancel();
        throw new OperationFailure(failure("decode", "decode", response.status));
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  let result: unknown;
  try {
    result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new OperationFailure(
      response.ok ? failure("decode", "decode", response.status) : refusal(),
    );
  }
  if (!response.ok) {
    const diagnostic = record(result) ? failureReceipt(result.failure) : undefined;
    throw new OperationFailure({
      ...(diagnostic ?? refusal()),
      httpStatus: response.status,
    });
  }
  if (!record(result) || result.action !== action)
    throw new OperationFailure(failure("decode", "decode", response.status));
  return result;
}
