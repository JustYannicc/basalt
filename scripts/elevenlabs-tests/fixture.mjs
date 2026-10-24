import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { URL } from "node:url";

const send = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
};

function specification(origin, voiceParameters) {
  return {
    openapi: "3.1.0",
    info: { title: "ElevenLabs local proof fixture", version: "fixture" },
    servers: [{ url: origin }],
    paths: {
      "/docs": { get: { responses: { "200": { description: "Removed by the published app patch" } } } },
      "/v1/voices": {
        get: {
          operationId: "listVoices",
          tags: ["Voices"],
          summary: "List voices for the current account",
          parameters: voiceParameters,
          responses: {
            "200": {
              description: "Voice list",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      voices: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            voice_id: { type: "string" },
                            name: { type: "string" },
                            category: { type: "string" },
                          },
                          required: ["voice_id", "name", "category"],
                        },
                      },
                    },
                    required: ["voices"],
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {},
  };
}

/** A loopback-only health and voice-list API. It never forwards a request. */
export async function startElevenLabsFixture(voiceParameters) {
  const tokens = {
    first: `synthetic-elevenlabs-first-${randomBytes(18).toString("hex")}`,
    second: `synthetic-elevenlabs-second-${randomBytes(18).toString("hex")}`,
  };
  const requests = [];
  let origin = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin || "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/openapi.json") {
      requests.push({ kind: "spec", method: request.method, path: url.pathname });
      return send(response, 200, specification(origin, voiceParameters));
    }

    const credential = request.headers["xi-api-key"];
    const principal = Object.entries(tokens).find(([, token]) => token === credential)?.[0] ?? "unknown";
    requests.push({
      kind: "api",
      method: request.method ?? "GET",
      path: url.pathname,
      authHeader: "xi-api-key",
      principal,
      showLegacy: url.searchParams.get("show_legacy") === "true",
    });
    if (principal === "unknown") return send(response, 401, { error: "unknown synthetic API key" });

    if (request.method === "GET" && url.pathname === "/v1/user")
      return send(response, 200, { user_id: `synthetic_elevenlabs_${principal}_user` });
    if (request.method === "GET" && url.pathname === "/v1/voices")
      return send(response, 200, {
        voices: [{
          voice_id: `synthetic_elevenlabs_${principal}_voice`,
          name: `Synthetic ${principal} voice`,
          category: "generated",
        }],
      });
    return send(response, 404, { error: "unmocked local route" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object", "Fixture server must expose a TCP port");
  origin = `http://127.0.0.1:${address.port}`;
  let stopped = false;
  return {
    origin,
    host: new URL(origin).host,
    tokens,
    requests,
    async stop() {
      if (stopped) return;
      stopped = true;
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
