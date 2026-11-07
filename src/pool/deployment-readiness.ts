import { Schema } from "effect";
import { openEnvelope } from "./token.ts";

export const deploymentReadinessPath = "/deployment-readiness";
export const deploymentReadinessPrefix = "sbpdr1";
export const RuntimeReady = Schema.Struct({
  candidate: Schema.String,
  workerInput: Schema.String,
  imageHash: Schema.String,
  desiredRevisionMatch: Schema.Literal(true),
  instanceId: Schema.String,
  bootId: Schema.String,
  readyAt: Schema.Number,
});
export type RuntimeReady = typeof RuntimeReady.Type;
const RequestTarget = Schema.Struct({
  candidate: Schema.String,
  workerInput: Schema.String,
  imageHash: Schema.String,
  at: Schema.Number,
  expiresAt: Schema.Number,
});

/** Only the private service entrypoint calls this, with a short-lived deployment signature. */
export async function handleDeploymentReadiness(
  request: Request,
  target: Pick<RuntimeReady, "candidate" | "workerInput" | "imageHash">,
  secret: string,
  ready: () => Promise<RuntimeReady>,
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
    const receipt = Schema.decodeUnknownSync(RuntimeReady)(await ready());
    return Response.json(receipt, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ outcome: "readiness-error", stage: "readiness" }, { status: 503 });
  }
}

export function decodeRuntimeReady(
  value: unknown,
  target: Pick<RuntimeReady, "candidate" | "workerInput" | "imageHash">,
): RuntimeReady {
  const receipt = Schema.decodeUnknownSync(RuntimeReady)(value);
  if (
    receipt.candidate !== target.candidate ||
    receipt.workerInput !== target.workerInput ||
    receipt.imageHash !== target.imageHash ||
    !/^[a-f0-9]{64}$/.test(receipt.instanceId) ||
    !/^[a-zA-Z0-9-]{1,128}$/.test(receipt.bootId) ||
    !Number.isSafeInteger(receipt.readyAt) ||
    receipt.readyAt < 0
  )
    throw new Error("Invalid runtime readiness receipt");
  return receipt;
}
