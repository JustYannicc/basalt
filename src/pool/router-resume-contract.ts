import { openEnvelope, signEnvelope } from "./token.ts";
import { resumeTargetShape } from "./stream-splice.ts";

/**
 * When the platform replaces the pool Worker's isolate mid-stream, the entry that would resume the
 * answer goes down with the controller. The router outlives both, so the entry hands it what a
 * resume needs: this stamp names the call's request id, the runtime that served it and its boot,
 * signed by the pool. The router sends it back with the offset it delivered, on this route, under
 * its own signed name for the same request id, so only the router that carried the call can resume
 * it, and only that call. Neither the stamp nor the route ever reaches a client.
 */
export const routerResumeHeader = "X-Basalt-Router-Resume";
export const routerResumePath = "/__basalt/router-resume/v1";
const stampPrefix = "sbrs1";
/** Longer than any answer the container's layer keeps; the layer's own 30 s idle limit decides. */
const stampTtlMs = 60 * 60_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ResumeStamp {
  requestId: string;
  target: string;
  boot: string;
}

export function signResumeStamp(secret: string, stamp: ResumeStamp) {
  return signEnvelope(secret, stampPrefix, { ...stamp, expiresAt: Date.now() + stampTtlMs });
}

export async function openResumeStamp(
  value: string | null,
  secret: string,
  previousSecret?: string,
): Promise<ResumeStamp | undefined> {
  if (!value) return undefined;
  const payload = await openEnvelope(secret, stampPrefix, value, previousSecret).catch(
    () => undefined,
  );
  if (typeof payload !== "object" || payload === null) return undefined;
  const { requestId, target, boot, expiresAt } = payload as Record<string, unknown>;
  if (
    typeof requestId !== "string" ||
    !uuid.test(requestId) ||
    typeof target !== "string" ||
    !resumeTargetShape.test(target) ||
    typeof boot !== "string" ||
    !/^[A-Za-z0-9._:-]{1,200}$/.test(boot) ||
    typeof expiresAt !== "number" ||
    expiresAt <= Date.now()
  )
    return undefined;
  return { requestId, target, boot };
}
