import { Option, Schema } from "effect";
import { RouteRefused } from "./control.ts";
import { WhenDown } from "./reading.ts";
import { routeIdPattern, routeOwnerPattern } from "./acquisition-contract.ts";

export { routeIdPattern };
export const RouteId = Schema.String.check(Schema.isPattern(routeIdPattern));
const Opaque = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const RouteOwner = Opaque.check(Schema.isPattern(routeOwnerPattern));

export const RouteMeta = Schema.Struct({
  routeId: RouteId,
  owner: RouteOwner,
  app: Opaque,
  // The host saves the account only after the sign-in connects; its first account step binds it.
  account: Schema.NullOr(Opaque),
});
export type RouteMeta = typeof RouteMeta.Type;
/** A person during sign-in, or a saved account in its organization when no person is present. */
const Caller = Schema.Union([
  Schema.Struct({ routeId: RouteId, owner: RouteOwner }),
  Schema.Struct({ routeId: RouteId, organization: Opaque, account: Opaque }),
]);
const CreateInput = Schema.Struct({ routeId: RouteId, owner: RouteOwner, app: Opaque });
export const SelectInput = Schema.Struct({ exitId: Schema.NullOr(Opaque), whenDown: WhenDown });
// Only the tools service, Basalt's own, calls the gateway, and an unknown field is refused. The two
// deploy as separate Workers and a release does not swap them at the same instant, so a new field
// ships to this reader first, and only then does the tools service start sending it.
const strict = { onExcessProperty: "error" } as const;

/** Malformed input crosses the RPC boundary as a reason code, never as schema text. */
export function decode<T, E>(schema: Schema.Codec<T, E>, input: unknown): T {
  const decoded = Schema.decodeUnknownOption(schema, strict)(input);
  if (Option.isNone(decoded)) throw new RouteRefused("route_not_permitted");
  return decoded.value;
}

export const metaKey = "route-v1:meta";
interface MetaStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

/** Who a route belongs to: set once at create, the account bound by the first account step. */
export class RouteAccess {
  private storage: MetaStorage;
  /** The name the DO was addressed by, when the platform reports it. */
  private name: string | undefined;
  constructor(storage: MetaStorage, name: string | undefined) {
    this.storage = storage;
    this.name = name;
  }

  async create(input: unknown) {
    const next = decode(CreateInput, input);
    if (this.name !== undefined && this.name !== next.routeId)
      throw new RouteRefused("route_not_permitted");
    const current = await this.storage.get<RouteMeta>(metaKey);
    if (current) {
      if (
        current.routeId !== next.routeId ||
        current.owner !== next.owner ||
        current.app !== next.app
      )
        throw new RouteRefused("route_not_permitted");
      return;
    }
    await this.storage.put(metaKey, { ...next, account: null } satisfies RouteMeta);
  }

  async meta() {
    const meta = await this.storage.get<RouteMeta>(metaKey);
    if (!meta) throw new RouteRefused("route_not_permitted");
    return meta;
  }

  /** The route's owner, when it was ever created. */
  async owner() {
    return (await this.storage.get<RouteMeta>(metaKey))?.owner;
  }

  /**
   * Every call names its route and either the person who started it or, for a saved account, that
   * account in the owner's organization. The first account step binds the account; any other
   * account, organization or person, and any malformed caller, is refused alike.
   */
  async authorize(input: unknown) {
    const caller = decode(Caller, input);
    const meta = await this.meta();
    if (meta.routeId !== caller.routeId) throw new RouteRefused("route_not_permitted");
    if ("owner" in caller) {
      if (meta.owner !== caller.owner) throw new RouteRefused("route_not_permitted");
      return meta;
    }
    if (meta.owner.split("/")[1] !== caller.organization)
      throw new RouteRefused("route_not_permitted");
    if (meta.account === null)
      await this.storage.put(metaKey, { ...meta, account: caller.account } satisfies RouteMeta);
    else if (meta.account !== caller.account) throw new RouteRefused("route_not_permitted");
    return meta;
  }
}
