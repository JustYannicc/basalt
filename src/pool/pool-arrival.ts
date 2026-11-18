/**
 * How the Worker's receive times reach the pool's Durable Object. The two run in different
 * isolates, so the only shared clock is wall time carried on the request itself. The Worker's
 * public entry overwrites the header on every call and the Durable Object strips it from every
 * request.
 */

export const poolReceiveHeader = "x-basalt-pool-receive";

/** What the Worker measured before it called the Durable Object. */
export interface PoolReceive {
  receivedAt: number;
  calledAt: number;
}

/** A request as the Durable Object received it, without the Worker's private timing header. */
export interface PoolArrival {
  request: Request;
  at: number;
  started: number;
  receive?: PoolReceive;
}

/** Overwrites whatever a caller sent: only the Worker's own clock reaches the Durable Object. */
export function stampPoolReceive(request: Request, receivedAt: number, now = Date.now()): Request {
  const headers = new Headers(request.headers);
  headers.set(poolReceiveHeader, `${Math.trunc(receivedAt)},${Math.trunc(now)}`);
  return new Request(request, { headers });
}

/** Read at the top of the Durable Object's handler, before any await, so the wait is the queue's. */
export function poolArrival(
  request: Request,
  at = Date.now(),
  started = performance.now(),
): PoolArrival {
  const value = request.headers.get(poolReceiveHeader);
  if (value === null) return { request, at, started };
  const headers = new Headers(request.headers);
  headers.delete(poolReceiveHeader);
  const stripped = new Request(request, { headers });
  const match = /^(\d{13}),(\d{13})$/.exec(value);
  const receivedAt = Number(match?.[1]);
  const calledAt = Number(match?.[2]);
  // Clocks of two isolates can differ slightly; a stamp from another minute is not this request's.
  const plausible =
    match !== null &&
    receivedAt <= calledAt &&
    calledAt <= at + 1_000 &&
    at - receivedAt <= 600_000;
  return {
    request: stripped,
    at,
    started,
    ...(plausible ? { receive: { receivedAt, calledAt } } : {}),
  };
}
