import { isPublicModelPath } from "./lifecycle.ts";

/**
 * Only model traffic follows its caller. Anything else (a fleet command, a start or install, a
 * handover step, a membership change, a migration) runs to its end or never starts, as it did before
 * the flag: its request gets a signal that never fires. Every fetch entry of the pool Worker passes
 * through here or `detachFromCaller`.
 */
export function followsCaller(request: Request): Request {
  return isPublicModelPath(new URL(request.url).pathname) ? request : detachFromCaller(request);
}

export function detachFromCaller(request: Request): Request {
  return new Request(request, { signal: new AbortController().signal });
}
