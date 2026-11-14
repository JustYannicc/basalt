import { serveTunnel } from "../../src/tunnel/session.ts";
import { tunnelMessageLimits } from "../../clients/contracts/tunnel.ts";

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== "/tunnel") return env.POOL.fetch(request);
    const pair = new WebSocketPair();
    const lease = new WebSocketPair();
    const access = {
      id: "native:synthetic",
      userId: "synthetic",
      clientId: "synthetic",
      expiresAt: Date.now() + 60_000,
      policy: { kind: "native", computer: "computer", pool: "pool", models: true },
    };
    serveTunnel(
      pair[1],
      lease[1],
      request,
      {
        POOL_APP_SIGNING_KEY: "ab".repeat(32),
        TOOLS_SERVICE: { fetch: async () => Response.json(access) },
        POOL_SERVICE: env.POOL,
      },
      access,
      (work) => ctx.waitUntil(work),
      undefined,
      tunnelMessageLimits,
    );
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "Sec-WebSocket-Protocol": "basalt.tunnel.v2" },
    });
  },
};
