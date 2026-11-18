import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { Effect, Exit, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { liveMainModuleSha256 } from "./live-module.ts";

const module = "export default { fetch() { return new Response('ok') } };\n";
const sourceMap = '{"version":3,"sources":[],"mappings":""}';

// The two-part body the content endpoint returns (prod-shapes 04): the module, then its source map.
async function contentServer(
  parts: { name: string; type: string; body: string }[],
  entrypoint?: string,
) {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(
      `${request.method} ${request.url} ${request.headers.authorization === "Bearer t" ? "auth" : "no-auth"}`,
    );
    const boundary = "x-boundary";
    const body =
      parts
        .map(
          (part) =>
            `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.name}"\r\nContent-Type: ${part.type}\r\n\r\n${part.body}\r\n`,
        )
        .join("") + `--${boundary}--\r\n`;
    response.writeHead(200, {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      ...(entrypoint ? { "cf-entrypoint": entrypoint } : {}),
    });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}/client/v4`, seen, close: () => server.close() };
}

const read = (origin: string) =>
  liveMainModuleSha256({
    accountId: "acct",
    token: Redacted.make("t"),
    script: "pool-worker",
    apiOrigin: origin,
  }).pipe(Effect.provide(FetchHttpClient.layer));

test("the digest is the main module's bytes, not the source map's", async () => {
  const server = await contentServer(
    [
      { name: "worker.js", type: "application/javascript+module", body: module },
      { name: "worker.js.map", type: "application/source-map", body: sourceMap },
    ],
    "worker.js",
  );
  try {
    const digest = await Effect.runPromise(read(server.origin));
    assert.equal(digest, createHash("sha256").update(module).digest("hex"));
    assert.deepEqual(server.seen, [
      "GET /client/v4/accounts/acct/workers/scripts/pool-worker/content/v2 auth",
    ]);
  } finally {
    server.close();
  }
});

test("more than one candidate module without an entrypoint header refuses", async () => {
  const server = await contentServer([
    { name: "a.js", type: "application/javascript+module", body: module },
    { name: "b.js", type: "application/javascript+module", body: module },
  ]);
  try {
    const exit = await Effect.runPromiseExit(read(server.origin));
    assert.equal(Exit.isFailure(exit), true);
    assert.match(JSON.stringify(exit), /expected one main module, found 2/u);
  } finally {
    server.close();
  }
});

test("no module refuses", async () => {
  const server = await contentServer([
    { name: "worker.js.map", type: "application/source-map", body: sourceMap },
  ]);
  try {
    const exit = await Effect.runPromiseExit(read(server.origin));
    assert.match(JSON.stringify(exit), /found 0/u);
  } finally {
    server.close();
  }
});
