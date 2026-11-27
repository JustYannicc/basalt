// What the stage Worker does with a call, apart from the Workers runtime: the key gate, profile b's
// control and the two account profiles. A custom endpoint account's base URL is `<origin>/a` or
// `<origin>/b`; each profile's path reaches the mock without its prefix and with its own faults.
import { mockRefusal, refusalPath, type MockPort } from "./mock-start.ts";

/** The faults a profile adds: the share of calls aimock answers 429, and its first-byte delay. */
export interface Chaos {
  rateLimitRate: number;
  latencyMs: number;
}
export const calm: Chaos = { rateLimitRate: 0, latencyMs: 0 };

/**
 * A platform reason that is plain words, or undefined. A dot only ends a sentence, so no host or
 * dotted name gets through.
 */
export const plainReason = (text: unknown): string | undefined =>
  typeof text === "string" && /^[A-Za-z](?:[A-Za-z ,'-]|\.(?= |$)){0,199}$/u.test(text)
    ? text
    : undefined;

/** Profile a never has faults; profile b's are read and replaced here during a run, no redeploy. */
export const profileControlPath = "/_emulated/profiles/b";

/**
 * Every profile 429 says when to try again. Home ends a cooldown exactly at a provider time of 10 s
 * or more (carry 0763); a shorter one, like aimock's own 1 s, only feeds its escalating backoff
 * (1, 2, 4 ... s up to 30 min), which keeps B out long after its 429 share drops. 15 s clears that
 * floor with room, so B rejoins the rotation about every 15 s, plus any grace its client adds.
 */
export const RETRY_AFTER_SECONDS = 15;

/** Profile b's faults, kept by the mock's Durable Object so they outlive the container. */
export interface ChaosStore {
  read(): Promise<Chaos>;
  write(chaos: Chaos): Promise<void>;
}

const encoder = new TextEncoder();
const digest = async (value: string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

/**
 * The key aimock also checks. Both sides are SHA-256 digests, so the comparison takes the same 32
 * steps whatever was sent; it runs the same in Node's tests as in the Worker.
 */
export async function keyed(request: Request, key: string): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const given = /^Bearer (.+)$/u.exec(header)?.[1] ?? request.headers.get("x-api-key") ?? "";
  const [a, b] = await Promise.all([digest(given), digest(key)]);
  let difference = a.length ^ b.length;
  for (let index = 0; index < a.length; index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0 && given.length > 0;
}

/** Every route, profile b's control included, is refused here before the mock's object wakes. */
export async function gate(
  request: Request,
  key: string,
  next: (request: Request) => Promise<Response>,
): Promise<Response> {
  if (!(await keyed(request, key)))
    return Response.json({ error: { type: "authentication_error" } }, { status: 401 });
  return next(request);
}

/** The profile a path names and the path the mock sees; undefined for an unprefixed path. */
export function profileRoute(pathname: string) {
  const match = /^\/(a|b)(\/.*)?$/u.exec(pathname);
  const profile = match?.[1];
  if (profile !== "a" && profile !== "b") return undefined;
  return { profile, pathname: match?.[2] ?? "/" };
}

// aimock's own grammar for a rate: a plain decimal. It ignores any other spelling, `1e-3` included.
const plainDecimal = /^(?:\d+(?:\.\d*)?|\.\d+)$/u;
const MAX_LATENCY_MS = 30_000;

/** Profile b's faults from a control body, or undefined unless it is exactly the two settings. */
export function chaosFrom(value: unknown): Chaos | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (Object.keys(value).sort().join() !== "latencyMs,rateLimitRate") return undefined;
  if (!("rateLimitRate" in value) || !("latencyMs" in value)) return undefined;
  const { rateLimitRate, latencyMs } = value;
  if (typeof rateLimitRate !== "number" || !plainDecimal.test(String(rateLimitRate)))
    return undefined;
  if (rateLimitRate > 1 || typeof latencyMs !== "number" || !Number.isSafeInteger(latencyMs))
    return undefined;
  if (latencyMs < 0 || latencyMs > MAX_LATENCY_MS) return undefined;
  return { rateLimitRate, latencyMs };
}

/** GET reads profile b's faults; PUT replaces both at once, so a half-set profile never runs. */
export async function profileControl(request: Request, store: ChaosStore): Promise<Response> {
  if (request.method === "GET") return Response.json({ profile: "b", ...(await store.read()) });
  if (request.method !== "PUT")
    return Response.json(
      { error: { type: "method_not_allowed" } },
      { status: 405, headers: { allow: "GET, PUT" } },
    );
  const chaos = chaosFrom(await request.json().catch(() => undefined));
  if (!chaos)
    return Response.json(
      {
        error: {
          type: "invalid_request_error",
          message: `Expected exactly { rateLimitRate: a plain decimal in [0, 1], latencyMs: a whole number in [0, ${MAX_LATENCY_MS}] }`,
        },
      },
      { status: 400 },
    );
  await store.write(chaos);
  return Response.json({ profile: "b", ...chaos });
}

// Every chaos field aimock 1.48.1 reads from a request. A header outranks a fixture's chaos and the
// server's default field by field, so setting all five makes a profile's faults exactly its own.
const chaosHeaders = {
  "x-aimock-chaos-drop": () => 0,
  "x-aimock-chaos-malformed": () => 0,
  "x-aimock-chaos-disconnect": () => 0,
  "x-aimock-chaos-ratelimit": (chaos: Chaos) => chaos.rateLimitRate,
  "x-aimock-chaos-latency": (chaos: Chaos) => chaos.latencyMs,
};

/** One retry time: Retry-After in whole seconds, without aimock's contradicting reset headers. */
export function retimed(answer: Response): Response {
  const headers = new Headers(answer.headers);
  for (const name of answer.headers.keys())
    if (name.startsWith("x-ratelimit-")) headers.delete(name);
  headers.set("retry-after", String(RETRY_AFTER_SECONDS));
  return new Response(answer.body, {
    status: answer.status,
    statusText: answer.statusText,
    headers,
  });
}

/** One keyed model call to the mock. An unprefixed path goes exactly as it came. */
export async function forward(mock: MockPort, request: Request, profileB: Chaos) {
  const url = new URL(request.url);
  const route = profileRoute(url.pathname);
  const target = new URL(`${route?.pathname ?? url.pathname}${url.search}`, "http://mock");
  const forwarded = new Request(target, request);
  if (!route) return mock.fetch(forwarded);
  const chaos = route.profile === "b" ? profileB : calm;
  for (const [header, value] of Object.entries(chaosHeaders))
    forwarded.headers.set(header, String(value(chaos)));
  const answer = await mock.fetch(forwarded);
  return answer.status === 429 ? retimed(answer) : answer;
}

/**
 * What the mock's Durable Object answers. Profile b's control needs no container, so changing a
 * profile never starts the mock; everything else waits until the mock answers its health route.
 */
export function mockCalls({
  store,
  start,
  key,
}: {
  store: ChaosStore;
  start(): Promise<MockPort>;
  key: string;
}) {
  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname === profileControlPath) return profileControl(request, store);
    let mock: MockPort;
    try {
      mock = await start();
    } catch (error) {
      // The platform's reason reaches the caller only when it is plain words, never a value.
      const message = error instanceof Error ? error.message : "";
      return Response.json(
        {
          error: {
            type: "mock_unavailable",
            message: plainReason(message) ?? "an unrecognised start failure",
          },
        },
        { status: 503 },
      );
    }
    if (pathname === refusalPath) return Response.json(await mockRefusal(mock, key));
    return forward(mock, request, await store.read());
  };
}
