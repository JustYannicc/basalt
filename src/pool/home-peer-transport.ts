import { Schema } from "effect";
import { HomePeerSource } from "./runtime-slots/peer-access.ts";

export const homePeerPath = "/_internal/home-peer";
const sourceHeader = "X-Signalbox-Home-Peer-Source";

/** Private stub fetch preserves upgrades; the public Worker never forwards this path. */
export function homePeerUpgrade(source: HomePeerSource, ordinal?: number) {
  return new Request(
    `http://home-peer.internal${homePeerPath}/${ordinal === undefined ? "open" : `route/${ordinal}`}`,
    { headers: { Upgrade: "websocket", [sourceHeader]: JSON.stringify(source) } },
  );
}

export async function handleHomePeerUpgrade(
  request: Request,
  handlers: {
    open(source: HomePeerSource): Promise<Response>;
    route?(source: HomePeerSource, ordinal: number): Promise<Response>;
  },
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const raw = request.headers.get(sourceHeader);
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
      url.hostname !== "home-peer.internal" ||
      url.search ||
      !raw ||
      raw.length > 16_384
    )
      return new Response(null, { status: 403 });
    const source = Schema.decodeUnknownSync(HomePeerSource, { onExcessProperty: "error" })(
      JSON.parse(raw),
    );
    if (url.pathname === `${homePeerPath}/open`) return await handlers.open(source);
    const route = /^\/_internal\/home-peer\/route\/(0|[1-9][0-9]{0,2})$/.exec(url.pathname);
    if (!route || Number(route[1]) > 128 || !handlers.route)
      return new Response(null, { status: 403 });
    return await handlers.route(source, Number(route[1]));
  } catch {
    return new Response(null, { status: 403 });
  }
}
