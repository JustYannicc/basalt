import { shape } from "./error-shape.ts";

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
  try {
    return await call();
  } catch (error) {
    const status = 500;
    log("POOL_OPERATIONS_CALL_FAILED", JSON.stringify({ route, status, ...shape(error) }));
    return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
  }
}
