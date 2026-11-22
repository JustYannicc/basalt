import { Option, Schema } from "effect";
import { readBody } from "../pool/json.ts";
import { openEnvelope } from "../pool/token.ts";
import {
  routeAcquisitionPrefix,
  type RouteAcquisitionClaims,
  type RouteAcquisitionFailure,
  type RouteAcquisitionReplies,
} from "./acquisition-contract.ts";
import { RouteId, RouteOwner, type RouteGatewayCore } from "./gateway.ts";
import { WhenDown } from "./reading.ts";

type Rpc<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};
export type RouteGatewayRpc = Rpc<
  Pick<
    RouteGatewayCore,
    "create" | "login" | "joinStatus" | "exits" | "select" | "reading" | "disconnect"
  >
>;

export interface RouteAcquisitionDependencies {
  signingKey: string;
  previousSigningKey: string | undefined;
  /** Undefined while the RouteGateway class is not declared. */
  gateway(routeId: string): RouteGatewayRpc | undefined;
  now(): number;
}

const Opaque = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const signed = { at: Schema.Finite, expiresAt: Schema.Finite, routeId: RouteId };
const account = { ...signed, organization: Opaque, account: Opaque };
const Claims = Schema.Union([
  Schema.Struct({ ...signed, action: Schema.Literal("start"), owner: RouteOwner, app: Opaque }),
  Schema.Struct({ ...signed, action: Schema.Literals(["status", "cancel"]), owner: RouteOwner }),
  Schema.Struct({ ...account, action: Schema.Literals(["check", "reading", "exits", "remove"]) }),
  Schema.Struct({
    ...account,
    action: Schema.Literal("select"),
    exitId: Schema.NullOr(Opaque),
    whenDown: WhenDown,
  }),
]);

const failure = (error: RouteAcquisitionFailure["error"]) =>
  Response.json({ error } satisfies RouteAcquisitionFailure, {
    status: error === "bad_request" ? 400 : error === "route_not_permitted" ? 403 : 503,
  });
const reply = <A extends keyof RouteAcquisitionReplies>(_: A, body: RouteAcquisitionReplies[A]) =>
  Response.json(body);

/** The tools service signs a request only after authenticating its caller; anything else is refused. */
async function claims(request: Request, deps: RouteAcquisitionDependencies) {
  const bytes = await readBody(request, 16_384);
  let body: unknown;
  try {
    body =
      bytes &&
      JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return "bad_request" as const;
  }
  const envelope =
    body && typeof body === "object" && "envelope" in body && typeof body.envelope === "string"
      ? body.envelope
      : undefined;
  if (!envelope) return "bad_request" as const;
  const opened = await openEnvelope(
    deps.signingKey,
    routeAcquisitionPrefix,
    envelope,
    deps.previousSigningKey,
  );
  if (opened === undefined) return "route_not_permitted" as const;
  const decoded = Schema.decodeUnknownOption(Claims, { onExcessProperty: "error" })(opened);
  if (Option.isNone(decoded)) return "bad_request" as const;
  // Typed as the shared wire's claims, so the decoder and the contract cannot drift apart.
  const value: RouteAcquisitionClaims = decoded.value;
  const now = deps.now();
  if (
    value.at > now + 5_000 ||
    value.expiresAt <= now ||
    value.expiresAt <= value.at ||
    value.expiresAt - value.at > 30_000
  )
    return "route_not_permitted" as const;
  return value;
}

export async function handleRouteAcquisition(
  request: Request,
  deps: RouteAcquisitionDependencies,
): Promise<Response> {
  if (request.method !== "POST") return failure("bad_request");
  const value = await claims(request, deps);
  if (typeof value === "string") return failure(value);
  const caller =
    "owner" in value
      ? { routeId: value.routeId, owner: value.owner }
      : { routeId: value.routeId, organization: value.organization, account: value.account };
  try {
    const gateway = deps.gateway(value.routeId);
    if (!gateway) return failure("route_gateway_unavailable");
    switch (value.action) {
      case "start": {
        await gateway.create({ ...caller, app: value.app });
        const login = await gateway.login(caller);
        // A fresh route id has no identity yet; a signed-in node cannot be started again.
        if (!("url" in login)) return failure("bad_request");
        return reply("start", login);
      }
      case "status":
        return reply("status", await gateway.joinStatus(caller));
      case "cancel":
      case "remove":
        return reply(value.action, await gateway.disconnect(caller));
      case "exits":
        return reply("exits", await gateway.exits(caller));
      case "select":
        return reply("select", {
          reading: await gateway.select(caller, { exitId: value.exitId, whenDown: value.whenDown }),
        });
      case "check":
      case "reading":
        return reply(value.action, { reading: await gateway.reading(caller) });
    }
  } catch (error) {
    // Only the reason code crosses back; gateway text, names and URLs stay inside.
    return failure(
      error instanceof Error && error.message === "route_not_permitted"
        ? "route_not_permitted"
        : "route_gateway_unavailable",
    );
  }
}
