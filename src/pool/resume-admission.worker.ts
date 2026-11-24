import { isPublicModelPath } from "./lifecycle.ts";
import { nativeResponse } from "./native-response.worker.ts";
import type { NativeStreamLease } from "./native-streams.ts";
import { resumedAnswer } from "./stream-resume.worker.ts";
import { decodeResumeInput, resumeGone, resumeRequest, type ResumeCall } from "./stream-resume.ts";
import type { TerminalOutcome } from "./terminal-protocol.ts";

interface Admission {
  native?: NativeStreamLease & { pool?: string };
  modelLease?: NativeStreamLease;
  identity?: { pool: string };
}
export type ResumeRefusal = "no_call" | "cut" | "refused";
type Parsed = NonNullable<ReturnType<typeof decodeResumeInput>>;

const release = (admitted: Admission) => {
  admitted.native?.release();
  admitted.modelLease?.release();
};

/**
 * A resumed part is governed as a first answer is. A call this instance ended on purpose (a
 * revocation, a pool's abort, a protection abort) is never resumed. Any other call passes the
 * admission a new call passes, under the pool it was first admitted under, so a caller no longer
 * allowed is refused, across a replacement too.
 */
export async function admitResume<A extends Admission>(
  input: { requestId: string; call?: ResumeCall },
  deps: {
    cut(requestId: string): boolean;
    admit(request: Request, requestId: string): Promise<A>;
  },
): Promise<A | ResumeRefusal> {
  const call = input.call;
  if (!call) return "no_call";
  if (deps.cut(input.requestId)) return "cut";
  let admitted: A;
  try {
    const url = new URL(call.path, "http://pool");
    // Only public model calls are stamped; anything else is not a call this resumes.
    if (!isPublicModelPath(url.pathname)) return "refused";
    admitted = await deps.admit(
      new Request(url, { method: call.method, headers: call.headers }),
      input.requestId,
    );
  } catch {
    return "refused";
  }
  const pool = admitted.identity?.pool ?? admitted.native?.pool;
  if (call.pool !== undefined && pool !== call.pool) {
    release(admitted);
    return "refused";
  }
  return admitted;
}

/**
 * The resumed part holds the leases its admission returned, as a first answer does, so whatever
 * cuts a first answer cuts it. Without a pool lease (no pool admission configured) it holds the
 * fallback, which a protection abort still reaches.
 */
export function admittedAnswer(
  answer: Response,
  admitted: Admission,
  deps: {
    from: number;
    fallback: () => NativeStreamLease;
    finish?: (outcome: TerminalOutcome, status: number, bytes: number) => void;
  },
) {
  if (answer.status !== 200) {
    release(admitted);
    return answer;
  }
  const resumed = resumedAnswer(answer, {
    from: deps.from,
    lease: admitted.modelLease ?? deps.fallback(),
    ...(deps.finish ? { finish: deps.finish } : {}),
  });
  return admitted.native ? nativeResponse(resumed, admitted.native) : resumed;
}

/**
 * The controller's resume: decoded, admitted, counted for the code handover and served. A handover
 * that began during admission refuses it, so a resume is refused or counted in one step.
 */
export async function governedResume(
  input: unknown,
  deps: {
    draining(): boolean;
    cut(requestId: string): boolean;
    admit(request: Request, requestId: string): Promise<Admission>;
    track(request: Request, work: () => Promise<Response>): Promise<Response>;
    serve(parsed: Parsed, request: Request): Promise<Response>;
    fallback(requestId: string, signal: AbortSignal): NativeStreamLease;
    finish(
      requestId: string,
    ): ((outcome: TerminalOutcome, status: number, bytes: number) => void) | undefined;
  },
): Promise<Response> {
  const parsed = decodeResumeInput(input);
  // While this object hands over, a resume answers gone, so the stream ends with today's terminal.
  if (!parsed || deps.draining()) return resumeGone();
  const admitted = await admitResume(parsed, deps);
  if (typeof admitted === "string") {
    console.info("POOL_STREAM_RESUME_REFUSED", { requestId: parsed.requestId, reason: admitted });
    return resumeGone();
  }
  if (deps.draining()) {
    release(admitted);
    return resumeGone();
  }
  const request = resumeRequest(parsed);
  const finish = deps.finish(parsed.requestId);
  const resumed = deps.track(request, async () =>
    admittedAnswer(await deps.serve(parsed, request), admitted, {
      from: parsed.from,
      fallback: () => deps.fallback(parsed.requestId, request.signal),
      ...(finish ? { finish } : {}),
    }),
  );
  // A resume that fails before its answer leaves no lease behind.
  resumed.catch(() => release(admitted));
  return resumed;
}
