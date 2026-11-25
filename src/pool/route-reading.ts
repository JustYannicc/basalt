import { Option, Schema } from "effect";

const Reading = Schema.Struct({
  state: Schema.Literals(["active", "down", "direct_fallback", "off", "needs_login"]),
  reason: Schema.NullOr(Schema.String),
  exitName: Schema.NullOr(Schema.String),
  path: Schema.Literals(["direct", "relay", "unknown"]),
  relayRegion: Schema.NullOr(Schema.String),
  since: Schema.Number,
});
/**
 * GET /pool's `route`: the caller's first routed credential's reading. Declared here, not in
 * apps/pool, so the pool app's source version is untouched; the screen adds it to PoolView.
 */
export type PoolRouteReading = typeof Reading.Type;
/** The gateway's own reading call (I2 `reading`), asked as the route's owner. */
export type RouteGatewayReader = (routeId: string, owner: string) => Promise<unknown>;

interface GatewayNamespace {
  idFromName(name: string): unknown;
  get(id: never): unknown;
}
/** RouteGateway(routeId).reading({ routeId, owner }): the DO decodes exactly those two keys. */
export function gatewayReader(namespace: GatewayNamespace): RouteGatewayReader {
  return (routeId, owner) => {
    const stub = namespace.get(namespace.idFromName(routeId) as never) as {
      reading(caller: { routeId: string; owner: string }): Promise<unknown>;
    };
    return stub.reading({ routeId, owner });
  };
}
const reasonCode = /^route_[a-z_]{2,40}$/;
// The pool's alarm interval: a pool view never starts the gateway's compute.
const freshMs = 5 * 60_000;
const failedMs = 30_000;
const readingMs = 2_000;

/** Readings for the pool view, cached so many views share one gateway call per interval. */
export class RouteReadings {
  private cache = new Map<string, { until: number; reading: PoolRouteReading }>();
  private reader?: RouteGatewayReader;
  private now: () => number;
  constructor(reader: RouteGatewayReader | undefined, now: () => number = Date.now) {
    this.reader = reader;
    this.now = now;
  }
  async read(routeId: string, owner: string): Promise<PoolRouteReading> {
    const key = `${owner}\n${routeId}`;
    const cached = this.cache.get(key);
    if (cached && cached.until > this.now()) return cached.reading;
    let reading: PoolRouteReading;
    let until = this.now() + freshMs;
    try {
      if (!this.reader) throw new Error("route gateway unavailable");
      // A slow gateway never holds the pool view.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answer = await Promise.race([
        this.reader(routeId, owner),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), readingMs);
        }),
      ]).finally(() => clearTimeout(timer));
      const value = Schema.decodeUnknownOption(Reading)(answer, { onExcessProperty: "ignore" });
      // A reading that doesn't decode is the gateway's failure, like any other.
      if (Option.isNone(value)) throw new TypeError("route_gateway_unavailable");
      reading = { ...value.value };
    } catch (error) {
      // The gateway's refusals cross RPC as an Error whose message is the reason code.
      const reason =
        error instanceof Error && reasonCode.test(error.message)
          ? error.message
          : "route_gateway_unavailable";
      reading = {
        state: "down",
        reason,
        exitName: null,
        path: "unknown",
        relayRegion: null,
        since: cached?.reading.since ?? this.now(),
      };
      until = this.now() + failedMs;
    }
    this.cache.set(key, { until, reading });
    return reading;
  }
}
