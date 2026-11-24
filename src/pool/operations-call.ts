import { shape } from "./error-shape.ts";

/**
 * A PoolOperations call into the controller that throws before the controller runs, such as an
 * argument RPC can't send, never reaches the controller's own refusal line. One closed line says
 * so: the route, the error's closed name and the status answered, which the lane prints too.
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
    log("POOL_OPERATIONS_CALL_FAILED", JSON.stringify({ route, error: shape(error).name, status }));
    return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
  }
}
