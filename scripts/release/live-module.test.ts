import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { Cause, Effect, Exit, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { LiveModuleUnavailable, liveMainModuleSha256 } from "./live-module.ts";

const module = "export default { fetch() { return new Response('ok') } };\n";
const uploaded = "export default { fetch() { return new Response('not deployed') } };\n";
const sourceMap = '{"version":3,"sources":[],"mappings":""}';
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

type Part = { name: string; type: string; body: string };
const script = (body: string): Part[] => [
  { name: "worker.js", type: "application/javascript+module", body },
  { name: "worker.js.map", type: "application/source-map", body: sourceMap },
];

/**
 * The two reads as production answers them: the deployments list (newest first, one version at
 * 100%, extra keys), and the content endpoint, whose multipart body holds the module and its source
 * map. Without `?version=` the content endpoint answers with the latest upload, which is not
 * necessarily the serving one.
 */
async function api(input: {
  serving: string;
  versions: Record<string, Part[]>;
  latest: Part[];
  entrypoint?: string;
  percentage?: number;
}) {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(
      `${request.method} ${request.url} ${request.headers.authorization === "Bearer t" ? "auth" : "no-auth"}`,
    );
    const url = new URL(request.url ?? "", "http://local");
    if (url.pathname.endsWith("/deployments")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          result: {
            deployments: [
              {
                id: "dep-serving",
                source: "api",
                strategy: "percentage",
                author_email: "someone@example.invalid",
                annotations: { "workers/triggered_by": "deployment" },
                versions: [{ version_id: input.serving, percentage: input.percentage ?? 100 }],
                created_on: "2026-11-18T18:51:18Z",
              },
            ],
          },
          success: true,
          errors: [],
          messages: [],
          result_info: { page: 1, per_page: 10, count: 1, total_count: 1, total_pages: 1 },
        }),
      );
      return;
    }
    const version = url.searchParams.get("version");
    const parts = version === null ? input.latest : input.versions[version];
    if (!parts) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: false, errors: [{ code: 10007 }], messages: [] }));
      return;
    }
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
      ...(input.entrypoint ? { "cf-entrypoint": input.entrypoint } : {}),
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

const refusal = (exit: Exit.Exit<unknown, unknown>) => {
  assert.ok(Exit.isFailure(exit), "expected a refusal");
  const error = Cause.squash(exit.cause);
  assert.ok(error instanceof LiveModuleUnavailable, String(error));
  return error.why;
};

test("the digest is the serving version's main module, not the source map's", async () => {
  const server = await api({
    serving: "v240",
    versions: { v240: script(module) },
    latest: script(module),
    entrypoint: "worker.js",
  });
  try {
    assert.equal(await Effect.runPromise(read(server.origin)), sha256(module));
    assert.deepEqual(server.seen, [
      "GET /client/v4/accounts/acct/workers/scripts/pool-worker/deployments auth",
      "GET /client/v4/accounts/acct/workers/scripts/pool-worker/content/v2?version=v240 auth",
    ]);
  } finally {
    server.close();
  }
});

test("when the latest upload is not deployed, the digest is still the serving version's", async () => {
  const server = await api({
    serving: "v240",
    versions: { v240: script(module), v241: script(uploaded) },
    latest: script(uploaded),
    entrypoint: "worker.js",
  });
  try {
    const digest = await Effect.runPromise(read(server.origin));
    assert.equal(digest, sha256(module));
    assert.notEqual(digest, sha256(uploaded));
  } finally {
    server.close();
  }
});

test("a split deployment refuses before any content is read", async () => {
  const split = await api({ serving: "v240", versions: {}, latest: [], percentage: 50 });
  try {
    assert.match(refusal(await Effect.runPromiseExit(read(split.origin))), /serving version/u);
    assert.ok(!split.seen.some((line) => line.includes("/content/")));
  } finally {
    split.close();
  }
});

test("a failed content read refuses", async () => {
  const server = await api({ serving: "v240", versions: {}, latest: script(module) });
  try {
    assert.equal(
      refusal(await Effect.runPromiseExit(read(server.origin))),
      "the content read failed",
    );
  } finally {
    server.close();
  }
});

test("more than one candidate module without an entrypoint header refuses", async () => {
  const parts = [
    { name: "a.js", type: "application/javascript+module", body: module },
    { name: "b.js", type: "application/javascript+module", body: module },
  ];
  const server = await api({ serving: "v240", versions: { v240: parts }, latest: parts });
  try {
    assert.equal(
      refusal(await Effect.runPromiseExit(read(server.origin))),
      "expected one main module, found 2",
    );
  } finally {
    server.close();
  }
});

test("no module refuses", async () => {
  const parts = [{ name: "worker.js.map", type: "application/source-map", body: sourceMap }];
  const server = await api({ serving: "v240", versions: { v240: parts }, latest: parts });
  try {
    assert.equal(
      refusal(await Effect.runPromiseExit(read(server.origin))),
      "expected one main module, found 0",
    );
  } finally {
    server.close();
  }
});

test("the entrypoint names the main module whatever its part's media type, among several modules", async () => {
  // As an Alchemy upload reads back: chunks beside the main module, no "+module" media type.
  const parts: Part[] = [
    { name: "chunk-1.js", type: "application/javascript", body: "export const a = 1;\n" },
    { name: "worker.js", type: "application/javascript", body: module },
    { name: "worker.js.map", type: "application/source-map", body: sourceMap },
  ];
  const server = await api({
    serving: "v240",
    versions: { v240: parts },
    latest: parts,
    entrypoint: "worker.js",
  });
  try {
    assert.equal(await Effect.runPromise(read(server.origin)), sha256(module));
  } finally {
    server.close();
  }
});
