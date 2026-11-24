import { isPublicModelPath } from "./lifecycle.ts";

/**
 * Only model traffic follows its caller. Anything else (a fleet command, a start or install, a
 * handover step, a membership change, a migration) runs to its end or never starts, as it did before
 * the flag: its signal never fires. Every fetch entry of the pool Worker passes through here
 * or `detachFromCaller`.
 */
export function followsCaller(request: Request): Request {
  return isPublicModelPath(new URL(request.url).pathname) ? request : detachFromCaller(request);
}

// No signal of its own: RPC refuses to clone a signal the script made (the platform's request signal
// is dropped), and the controller's /runtime-handoff takes its request over RPC.
export function detachFromCaller(request: Request): Request {
  return new Request(request, { signal: null });
}
