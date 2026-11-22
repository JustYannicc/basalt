import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Cause, Effect, Exit, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { failureReport } from "./public-report.ts";
import { changedSecrets, rollbackTo, servingVersion } from "./worker-version.ts";

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

/** How the fake answers a rollback deployment: accept, refuse, or refuse unless it is forced. */
type Post =
  | boolean
  | { readonly code: number; readonly message: string; readonly yieldsToForce: boolean };

async function api(initial: ReturnType<typeof deployment>[], post: Post = true) {
  const deployments = [...initial];
  const seen: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push(`${request.method} ${request.url}`);
      if (request.method === "POST") {
        const refusal =
          post === false
            ? { code: 10211, message: "fixture: the version cannot be deployed" }
            : post === true || (post.yieldsToForce && request.url?.endsWith("?force=true"))
              ? undefined
              : post;
        if (refusal) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ success: false, errors: [refusal] }));
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
    // Cloudflare's own answer is kept in the private detail, never in the public text.
    assert.ok(Exit.isFailure(exit));
    const report = failureReport(Cause.squash(exit.cause));
    for (const kept of ['"status":400', '"code":10211', "the version cannot be deployed"]) {
      assert.ok(report.detail.includes(kept), kept);
      assert.equal(report.publicText.includes(kept), false, kept);
    }
  } finally {
    server.close();
  }
});

// Cloudflare's answer to lane 6's refused rollback, word for word but for the secret it named.
const secretChanged = (names: string) => ({
  code: 10220,
  message: `A secret has changed since this version was active. If you are sure this is ok, add a ?force=true query parameter to allow the rollback. The following secrets have changed: ${names}`,
});
const deployments = "/client/v4/accounts/acct/workers/scripts/pool/deployments";

test("a rollback refused only for a per-release secret is sent again with force, and says so", async () => {
  const server = await api([deployment("v241"), deployment("v240")], {
    ...secretChanged("EXECUTOR_TELEMETRY"),
    yieldsToForce: true,
  });
  try {
    const exit = await run(withHttp(rollbackTo(target(server.origin), "v240", "rollback")));
    assert.deepEqual(exit, Exit.succeed({ id: "dep-new", forcedSecrets: ["EXECUTOR_TELEMETRY"] }));
    assert.deepEqual(server.seen, [
      `POST ${deployments}`,
      `POST ${deployments}?force=true`,
      `GET ${deployments}`,
    ]);
  } finally {
    server.close();
  }
});

test("a changed secret outside the reviewed list keeps the refusal, and nothing is forced", async () => {
  // Lane 6's case: the stage's deadline, a secret that is not a release's own.
  for (const names of ["TEST_STAGE_EXPIRES_AT", "EXECUTOR_TELEMETRY, TEST_STAGE_EXPIRES_AT"]) {
    const server = await api([deployment("v241")], { ...secretChanged(names), yieldsToForce: true });
    try {
      const exit = await run(withHttp(rollbackTo(target(server.origin), "v240", "rollback")));
      assert.ok(Exit.isFailure(exit), names);
      assert.deepEqual(server.seen, [`POST ${deployments}`], names);
      const report = failureReport(Cause.squash(exit.cause));
      assert.ok(report.detail.includes('"code":10220'), names);
      assert.equal(report.publicText.includes("TEST_STAGE_EXPIRES_AT"), false, names);
    } finally {
      server.close();
    }
  }
});

test("a forced rollback Cloudflare still refuses keeps both answers, privately", async () => {
  const server = await api([deployment("v241")], {
    ...secretChanged("EXECUTOR_TELEMETRY"),
    yieldsToForce: false,
  });
  try {
    const exit = await run(withHttp(rollbackTo(target(server.origin), "v240", "rollback")));
    assert.ok(Exit.isFailure(exit));
    assert.equal(server.seen.length, 2);
    const report = failureReport(Cause.squash(exit.cause));
    assert.match(report.detail, /"forced":\{"status":400/u);
    assert.equal(report.publicText.includes("EXECUTOR_TELEMETRY"), false);
  } finally {
    server.close();
  }
});

test("only a message that names its secrets in Cloudflare's form yields names", () => {
  assert.deepEqual(changedSecrets(secretChanged("EXECUTOR_TELEMETRY").message), [
    "EXECUTOR_TELEMETRY",
  ]);
  assert.deepEqual(changedSecrets(secretChanged("A_ONE, B_TWO.").message), ["A_ONE", "B_TWO"]);
  for (const message of [
    "A secret has changed since this version was active.",
    secretChanged("").message,
    secretChanged("EXECUTOR TELEMETRY").message,
    secretChanged("EXECUTOR_TELEMETRY, ").message,
  ])
    assert.equal(changedSecrets(message), undefined, message);
});
