import assert from "node:assert/strict";
import { createServer } from "node:http";

/** One-shot promises synchronize only the disposable proof server's SQL transactions. */
export async function oauthRemovalGate() {
  const gates = new Map<
    string,
    {
      account?: string;
      entered: PromiseWithResolvers<string>;
      release: PromiseWithResolvers<void>;
      settled: PromiseWithResolvers<boolean>;
    }
  >();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const step = url.searchParams.get("step"),
        id = url.searchParams.get("id");
      assert.ok(step === "renewal" || step === "identification" || step === "delete");
      assert.ok(typeof id === "string" && (id === "any" || id.startsWith("acc_")));
      const key = `${step}/${id}`;
      if (url.pathname === "/arm") {
        assert.ok(!gates.has(key), "Gate already armed");
        gates.set(key, {
          entered: Promise.withResolvers<string>(),
          release: Promise.withResolvers<void>(),
          settled: Promise.withResolvers<boolean>(),
        });
      } else {
        const gate = gates.get(key) ?? gates.get(`${step}/any`);
        if (url.pathname === "/arrive") {
          if (gate !== undefined && gate.account === undefined) {
            gate.account = id;
            gate.entered.resolve(id);
            await gate.release.promise;
          }
        } else if (url.pathname === "/finish") {
          if (gate?.account === id)
            gate.settled.resolve(url.searchParams.get("committed") === "true");
        } else if (url.pathname === "/entered" && gate !== undefined) {
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ account: await gate.entered.promise }));
          return;
        } else if (url.pathname === "/settled" && gate !== undefined) {
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ committed: await gate.settled.promise }));
          return;
        } else if (url.pathname === "/release") gate?.release.resolve();
        else throw new Error("Unknown gate command");
      }
      response.writeHead(204).end();
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const gate of gates.values()) gate.release.resolve();
      gates.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
