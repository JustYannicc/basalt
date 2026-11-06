import { createServer } from "node:http";
import { once } from "node:events";

/** A synthetic credential check and send provider, with a controllable lost reply. */
export async function startRecipeUpstream() {
  let health = "rejected";
  let hold = false;
  let accepted;
  const replies = new Set();
  const healthReplies = new Set();
  let heldToken;
  let holdAfter = 1;
  let matchingReads = 0;
  let healthAccepted;
  const sends = [];
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/health") {
      const matched = request.headers["x-fixture-account"] === heldToken && heldToken !== undefined;
      if (matched) matchingReads++;
      if (matched && matchingReads >= holdAfter) {
        healthReplies.add(response);
        healthAccepted?.();
      } else response.end(JSON.stringify({ status: health }));
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
  const origin = new URL("http://127.0.0.1");
  origin.port = String(server.address().port);
  return {
    origin: origin.origin,
    sends,
    setHealth(value) {
      health = value;
    },
    holdHealth(token, after = 1) {
      heldToken = token;
      holdAfter = after;
      matchingReads = 0;
      return new Promise((resolve) => {
        healthAccepted = resolve;
      });
    },
    releaseHealth() {
      heldToken = undefined;
      for (const response of healthReplies) response.end(JSON.stringify({ status: health }));
      healthReplies.clear();
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
      this.releaseHealth();
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) =>
          error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve(),
        ),
      );
    },
  };
}
