import { createServer } from "node:http";
import { once } from "node:events";

/** A synthetic credential check and send provider, with a controllable lost reply. */
export async function startRecipeUpstream() {
  let health = "rejected";
  let hold = false;
  let accepted;
  const replies = new Set();
  const sends = [];
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ status: health }));
      return;
    }
    if (request.url !== "/send" || request.method !== "POST") {
      response.writeHead(404).end("{}");
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    sends.push(JSON.parse(body));
    accepted?.();
    if (hold) replies.add(response);
    else response.end(JSON.stringify({ receipt: `fixture-${sends.length}` }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    sends,
    setHealth(value) {
      health = value;
    },
    holdNext() {
      hold = true;
      return new Promise((resolve) => {
        accepted = resolve;
      });
    },
    release() {
      hold = false;
      for (const response of replies) response.destroy();
      replies.clear();
    },
    async stop() {
      this.release();
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
