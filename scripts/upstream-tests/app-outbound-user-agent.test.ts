import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { Miniflare } = require("miniflare") as typeof import("miniflare");

// Execute the private Worker's actual deployed script, not a copy of its fetch handler.
const source = readFileSync(
  new URL("../../.upstream/apps/hosted/cloud/src/infrastructure/app-outbound.ts", import.meta.url),
  "utf8",
);
const literal = source.match(/script: (`[^`]*`)/)?.[1];
assert.ok(literal, "AppOutbound must declare its Worker script");
const script = new Function(`return ${literal}`)() as string;

test("app outbound supplies the User-Agent GitHub requires and preserves explicit request headers", async () => {
  const delivered: {
    url: string;
    method: string;
    agent: string | null;
    auth: string | null;
    body: string;
  }[] = [];
  const mf = new Miniflare({
    modules: [
      {
        type: "ESModule",
        path: "entry.mjs",
        contents: `import outbound from "./outbound.mjs";
        export default { fetch(request) {
          const headers = new Headers(request.headers);
          if (headers.get("user-agent") === "fixture-absent") headers.delete("user-agent");
          return outbound.fetch(new Request(request, { headers }));
        } };`,
      },
      { type: "ESModule", path: "outbound.mjs", contents: script },
    ],
    compatibilityDate: "2026-08-06",
    outboundService: async (request: Request) => {
      const agent = request.headers.get("user-agent");
      delivered.push({
        url: request.url,
        method: request.method,
        agent,
        auth: request.headers.get("authorization"),
        body: await request.text(),
      });
      // GitHub's front door returns this 403 before checking the bearer token.
      return agent
        ? Response.json({ login: "fixture" })
        : new Response("Please make sure your request has a User-Agent header", { status: 403 });
    },
  });
  try {
    const health = await mf.dispatchFetch("https://api.github.com/user", {
      headers: { Authorization: "Bearer fixture", "User-Agent": "fixture-absent" },
    });
    assert.equal(health.status, 200, "GitHub health must pass the User-Agent gate");
    assert.ok(delivered[0]!.agent);
    assert.equal(delivered[0]!.auth, "Bearer fixture");
    const explicit = await mf.dispatchFetch("https://api.github.com/user?fixture=1", {
      method: "POST",
      headers: { "User-Agent": "app-owned-agent", Authorization: "Bearer fixture" },
      body: "request-body",
    });
    assert.equal(explicit.status, 200);
    assert.deepEqual(delivered[1], {
      url: "https://api.github.com/user?fixture=1",
      method: "POST",
      agent: "app-owned-agent",
      auth: "Bearer fixture",
      body: "request-body",
    });
  } finally {
    await mf.dispose();
  }
});
