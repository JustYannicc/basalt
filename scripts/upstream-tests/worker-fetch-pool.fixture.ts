import { nativeModelHeader, nativeModelPrefix } from "../../src/pool/native-contract.ts";
import { fixture, pool, signingKey } from "../../src/pool/test/computers.ts";
import { signEnvelope } from "../../src/pool/token.ts";

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
    if (url.pathname === "/fixture/model") {
      // The model key is minted and sealed on the device's first model use, inside workerd.
      const computer = Object.values(await p.registry()).find((row) => row.native?.models);
      if (!computer?.native) return Response.json({ error: "no model device" }, { status: 404 });
      const assertion = await signEnvelope(signingKey, nativeModelPrefix, {
        user: computer.user,
        grant: computer.native.grant,
        computer: computer.id,
        pool: computer.pool,
        method: "POST",
        path: "/v1/responses",
        expiresAt: p.now() + 10_000,
      });
      const lease = await p.nativeModel(
        new Request("https://pool.example/v1/responses", {
          method: "POST",
          headers: { [nativeModelHeader]: assertion },
          body: "{}",
        }),
      );
      lease.release();
      return Response.json({ forwarded: true });
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
