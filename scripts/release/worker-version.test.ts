import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Effect, Exit, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { rollbackTo, servingVersion } from "./worker-version.ts";

// The deployments list as production returns it: extra keys, newest first.
const deployment = (
  version: string,
  percentage = 100,
  extra: { version_id: string; percentage: number }[] = [],
) => ({
  id: `dep-${version}`,
  source: "api",
  strategy: "percentage",
  author_email: "someone@example.invalid",
  annotations: { "workers/triggered_by": "deployment" },
  versions: [{ version_id: version, percentage }, ...extra],
  created_on: "2026-11-18T18:51:18Z",
});

async function api(initial: ReturnType<typeof deployment>[], acceptPost = true) {
  const deployments = [...initial];
  const seen: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push(`${request.method} ${request.url}`);
      if (request.method === "POST") {
        if (!acceptPost) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ success: false, errors: [{ code: 10211 }] }));
          return;
        }
        const posted = JSON.parse(body);
        deployments.unshift(deployment(posted.versions[0].version_id));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ success: true, result: { id: "dep-new", ...posted } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          success: true,
          errors: [],
          result: { deployments },
          result_info: {
            page: 1,
            per_page: 10,
            count: deployments.length,
            total_count: 231,
            total_pages: 24,
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}/client/v4`, seen, close: () => server.close() };
}
const target = (origin: string) => ({
  accountId: "acct",
  token: Redacted.make("t"),
  script: "pool",
  apiOrigin: origin,
});
const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromiseExit(effect);
const withHttp = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(FetchHttpClient.layer)) as Effect.Effect<A, E, never>;

test("the serving version is the newest deployment's single 100% version", async () => {
  const server = await api([deployment("v240"), deployment("v239")]);
  try {
    const exit = await run(withHttp(servingVersion(target(server.origin))));
    assert.deepEqual(exit, Exit.succeed("v240"));
  } finally {
    server.close();
  }
});

test("a split deployment refuses, since there is no single version to roll back to", async () => {
  const server = await api([deployment("v241", 50, [{ version_id: "v240", percentage: 50 }])]);
  try {
    const exit = await run(withHttp(servingVersion(target(server.origin))));
    assert.match(JSON.stringify(exit), /not served by exactly one version/u);
  } finally {
    server.close();
  }
});

test("a rollback deploys the earlier version at 100% and proves it now serves", async () => {
  const server = await api([deployment("v241"), deployment("v240")]);
  try {
    const exit = await run(
      withHttp(rollbackTo(target(server.origin), "v240", "rollback after failed acceptance")),
    );
    assert.ok(Exit.isSuccess(exit));
    assert.deepEqual(server.seen, [
      "POST /client/v4/accounts/acct/workers/scripts/pool/deployments",
      "GET /client/v4/accounts/acct/workers/scripts/pool/deployments",
    ]);
    assert.deepEqual(
      await run(withHttp(servingVersion(target(server.origin)))),
      Exit.succeed("v240"),
    );
  } finally {
    server.close();
  }
});

test("a rollback Cloudflare refuses (for example across a class change) fails loudly", async () => {
  const server = await api([deployment("v241")], false);
  try {
    const exit = await run(withHttp(rollbackTo(target(server.origin), "v240", "rollback")));
    assert.match(JSON.stringify(exit), /did not accept the rollback/u);
  } finally {
    server.close();
  }
});
