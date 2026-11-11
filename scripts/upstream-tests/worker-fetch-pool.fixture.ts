import { fixture, pool } from "../../src/pool/test/computers.ts";

const p = fixture();
let controlCalls = 0;
let redirectedCalls = 0;
export default {
  async fetch(request: Request, env: { redirect: boolean }) {
    p.advance(Date.now() - p.now());
    const url = new URL(request.url);
    if (url.pathname === "/fixture/intent") {
      const user = url.searchParams.get("user")!;
      return Response.json({
        intent: await p.intent(user, { ...pool, owner: user }),
        pool: pool.pool,
      });
    }
    if (url.pathname === "/fixture/state") {
      return Response.json({
        controlCalls,
        redirectedCalls,
        computers: Object.values(await p.registry()).map((computer) => ({
          state: computer.state,
          models: computer.native?.models,
          hasSealedKey: !!computer.native?.key,
        })),
      });
    }
    if (url.pathname === "/redirected") {
      redirectedCalls++;
      return Response.json({ error: "a credential-bearing redirect must never be followed" });
    }
    controlCalls++;
    if (env.redirect)
      return Response.redirect("https://synthetic-provider.invalid/redirected", 302);
    return p.nativeControl(request);
  },
};
