import { createServer } from "node:http";

/** Only the disposable proof server sees these gates; production never loads this module. */
export async function adoptionStepGate() {
  const gates = new Map<
    string,
    {
      arrived: PromiseWithResolvers<void>;
      release: PromiseWithResolvers<void>;
      claimed: boolean;
    }
  >();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const step = url.searchParams.get("step");
      const id = url.searchParams.get("id");
      if (!step || !id || !["organization", "app", "account"].includes(step)) {
        response.writeHead(400).end();
        return;
      }
      const key = `${step}/${id}`;
      if (url.pathname !== "/arrive" || gates.has(key))
        process.stderr.write(`adoption-step ${url.pathname} ${step}\n`);
      if (url.pathname === "/arm") {
        if (gates.has(key)) throw new Error("Gate already armed");
        gates.set(key, {
          arrived: Promise.withResolvers<void>(),
          release: Promise.withResolvers<void>(),
          claimed: false,
        });
      } else {
        const gate = gates.get(key);
        if (url.pathname === "/arrive") {
          if (gate !== undefined && !gate.claimed) {
            gate.claimed = true;
            gate.arrived.resolve();
            await gate.release.promise;
          }
        } else if (url.pathname === "/entered" && gate !== undefined) {
          await gate.arrived.promise;
        } else if (url.pathname === "/release") {
          gate?.release.resolve();
          gates.delete(key);
        } else {
          response.writeHead(404).end();
          return;
        }
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
  if (address === null || typeof address === "string") throw new Error("TCP gate required");
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
