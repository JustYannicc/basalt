import { shape } from "./error-shape.ts";

/**
 * Set on every answer that leaves through here. The operator's bridge reaches this entrypoint
 * through proxies that build their own 500s, so an answer without it never came from the pool.
 */
export const poolOperationsAnswerHeader = "X-Signalbox-Pool-Operations";
const ownAnswer = "answered";

/** Whether the PoolOperations entrypoint itself gave this answer, not a hop in front of it. */
export const poolOperationsAnswered = (response: Response) =>
  response.headers.get(poolOperationsAnswerHeader) === ownAnswer;

/**
 * A PoolOperations call into the controller that throws never reaches, or never returns from, the
 * controller's own refusal line: an argument RPC can't send throws before the controller runs, and
 * a reset or a lost connection mid-call throws after it may have acted. One closed line says which
 * by the error's closed shape, as POOL_CONTROLLER_CALL_FAILED does, with the route and the status
 * it answers, which the lane prints too.
 */
export async function throughController(
  route: string,
  call: () => Promise<Response>,
  log: (marker: string, line: string) => void = console.error,
) {
  let response: Response;
  try {
    response = await call();
  } catch (error) {
    const status = 500;
    log("POOL_OPERATIONS_CALL_FAILED", JSON.stringify({ route, status, ...shape(error) }));
    return new Response(null, {
      status,
      headers: { "Cache-Control": "no-store", [poolOperationsAnswerHeader]: ownAnswer },
    });
  }
  // An answer returned over RPC may hold immutable headers; the copy keeps its body streaming.
  const answer = new Response(response.body, response);
  answer.headers.set(poolOperationsAnswerHeader, ownAnswer);
  return answer;
}
