import { Schema } from "effect";
import { openEnvelope } from "./token.ts";

export const deploymentReadinessPath = "/deployment-readiness";
export const deploymentReadinessPrefix = "sbpdr1";
const targetFields = {
  candidate: Schema.String,
  workerInput: Schema.String,
  imageHash: Schema.String,
};
export const RuntimeIdentity = Schema.Struct({ ...targetFields, instanceId: Schema.String });
export type RuntimeIdentity = typeof RuntimeIdentity.Type;
export type RuntimeTarget = Pick<RuntimeIdentity, "candidate" | "workerInput" | "imageHash">;
export type ReadinessPhase = "adoption" | "runtime";
export const RuntimeReady = Schema.Struct({
  ...RuntimeIdentity.fields,
  desiredRevisionMatch: Schema.Literal(true),
  bootId: Schema.String,
  readyAt: Schema.Number,
});
export type RuntimeReady = typeof RuntimeReady.Type;
const RequestTarget = Schema.Struct({
  ...targetFields,
  phase: Schema.optional(Schema.Literals(["adoption", "runtime"])),
  at: Schema.Number,
  expiresAt: Schema.Number,
});

/** Only the private service entrypoint calls this, with a short-lived deployment signature. */
export async function handleDeploymentReadiness(
  request: Request,
  target: RuntimeTarget,
  secret: string,
  ready: (phase: ReadinessPhase) => Promise<unknown>,
  now = Date.now,
) {
  try {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const text = await request.text();
    if (text.length > 8192) return new Response(null, { status: 413 });
    const body = Schema.decodeUnknownSync(Schema.Struct({ envelope: Schema.String }))(
      JSON.parse(text),
    );
    const value = Schema.decodeUnknownSync(RequestTarget)(
      await openEnvelope(secret, deploymentReadinessPrefix, body.envelope),
    );
    if (
      !Number.isSafeInteger(value.at) ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.at > now() + 5000 ||
      value.expiresAt <= now() ||
      value.expiresAt <= value.at ||
      value.expiresAt > value.at + 60_000
    )
      return new Response(null, { status: 401 });
    if (
      value.candidate !== target.candidate ||
      value.workerInput !== target.workerInput ||
      value.imageHash !== target.imageHash
    )
      return new Response(null, { status: 409 });
    const phase = value.phase ?? "runtime";
    const observed = await ready(phase);
    if (phase === "adoption") {
      const identity = decodeRuntimeIdentity(observed);
      if (!sameRuntimeTarget(identity, target))
        return Response.json(
          { outcome: "adopting", observed: identity },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      return Response.json(identity, { headers: { "Cache-Control": "no-store" } });
    }
    const receipt = decodeRuntimeReady(observed, target);
    return Response.json(receipt, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ outcome: "readiness-error", stage: "readiness" }, { status: 503 });
  }
}

export function decodeRuntimeIdentity(value: unknown): RuntimeIdentity {
  const identity = Schema.decodeUnknownSync(RuntimeIdentity)(value);
  if (
    !/^[a-f0-9]{40}$/.test(identity.candidate) ||
    !/^[a-f0-9]{64}$/.test(identity.workerInput) ||
    !/^[a-f0-9]{1,64}$/.test(identity.imageHash) ||
    !/^[a-f0-9]{64}$/.test(identity.instanceId)
  )
    throw new Error("Invalid runtime code identity");
  return identity;
}

export const sameRuntimeTarget = (identity: RuntimeTarget, target: RuntimeTarget) =>
  identity.candidate === target.candidate &&
  identity.workerInput === target.workerInput &&
  identity.imageHash === target.imageHash;

export function decodeRuntimeReady(
  value: unknown,
  target: Pick<RuntimeReady, "candidate" | "workerInput" | "imageHash">,
): RuntimeReady {
  const receipt = Schema.decodeUnknownSync(RuntimeReady)(value);
  if (
    !sameRuntimeTarget(receipt, target) ||
    !/^[a-f0-9]{64}$/.test(receipt.instanceId) ||
    !/^[a-zA-Z0-9-]{1,128}$/.test(receipt.bootId) ||
    !Number.isSafeInteger(receipt.readyAt) ||
    receipt.readyAt < 0
  )
    throw new Error("Invalid runtime readiness receipt");
  return receipt;
}
