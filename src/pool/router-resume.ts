import { openRouterAttempt, routerAttemptHeader } from "./router-attempt.ts";
import { openResumeStamp } from "./router-resume-contract.ts";
import { resumeCall, type StreamResumeInput } from "./stream-resume.ts";

export {
  openResumeStamp,
  routerResumeHeader,
  routerResumePath,
  signResumeStamp,
} from "./router-resume-contract.ts";

/**
 * The pool entry's side: a resume asked for by the router that carried the call. The router's name
 * must be signed and must name the stamp's own request id; anything else is refused before the
 * controller is asked, so a stamp lifted from one call never resumes another. The router sends the
 * call's own method, path and credentials, which the pool admits as it admits a new call.
 */
export async function routerResume(
  request: Request,
  keys: { key: string; previous?: string },
  resume: (input: StreamResumeInput, call: Request) => Promise<Response>,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const named = await openRouterAttempt(request, keys.key, keys.previous);
  if (!named) return new Response(null, { status: 403 });
  // A stamp and an offset are a few hundred bytes; nothing larger is read.
  const text = await request.text();
  let body: unknown;
  try {
    body = text.length <= 8_192 ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  const {
    stamp: value,
    from,
    method,
    path,
  } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const stamp = await openResumeStamp(
    typeof value === "string" ? value : null,
    keys.key,
    keys.previous,
  );
  if (
    !named ||
    !stamp ||
    named.requestId !== stamp.requestId ||
    typeof from !== "number" ||
    !Number.isSafeInteger(from) ||
    from < 0 ||
    (method !== "POST" && method !== "GET") ||
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.length > 8_192
  )
    return new Response(null, { status: 403 });
  const headers = new Headers(request.headers);
  headers.delete(routerAttemptHeader);
  const call = new Request(new URL(path, request.url), { method, headers });
  try {
    return await resume(
      {
        requestId: stamp.requestId,
        from,
        target: stamp.target,
        boot: stamp.boot,
        call: { ...resumeCall(call), ...(stamp.pool ? { pool: stamp.pool } : {}) },
      },
      call,
    );
  } catch {
    // The controller is not reachable yet, as when it is starting in a new instance: not gone.
    return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
  }
}
