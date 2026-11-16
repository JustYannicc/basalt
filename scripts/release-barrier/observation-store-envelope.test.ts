import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { observationStoreEnvelope } from "./observation-store-envelope.ts";

const account = "1".repeat(32);
const prefix = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/`;

function fixture() {
  const sent: { method: string; path: string }[] = [];
  const log: { phase: string; method: string; path: string; disposition: string }[] = [];
  const nativeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    sent.push({ method: request.method, path });
    return Response.json({
      success: true,
      errors: [],
      messages: [],
      result: path.endsWith("/subdomain/edge-preview")
        ? { token: "synthetic-session" }
        : { preview_token: "synthetic-preview" },
    });
  };
  return {
    sent,
    log,
    envelope: observationStoreEnvelope(
      account,
      async (entry) => {
        log.push(entry);
      },
      nativeFetch,
    ),
  };
}

test("the actual SDK's State-auth request methods pass only during auth and produce exact counts", async () => {
  const f = fixture();
  f.envelope.beginAuth();
  await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Workers.createSubdomainEdgePreviewSession({ accountId: account });
      assert.equal(session.token, "synthetic-session");
      const preview = yield* Workers.createScriptEdgePreview({
        accountId: account,
        scriptName: "alchemy-state-store",
        cfPreviewUploadConfigToken: session.token,
        metadata: { mainModule: "worker.js" },
        files: [new File(["export default {}"], "worker.js")],
      });
      assert.equal(preview.previewToken, "synthetic-preview");
    }).pipe(
      Retry.none,
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, f.envelope.fetch),
      Effect.provideService(
        Credentials,
        Effect.succeed({
          type: "apiToken",
          apiToken: Redacted.make("synthetic-deployer"),
          apiBaseUrl: "https://api.cloudflare.com/client/v4",
        }),
      ),
    ),
  );
  f.envelope.endAuth();
  assert.deepEqual(
    f.sent.map((entry) => entry.method),
    ["GET", "POST"],
  );
  assert.deepEqual(
    f.log.map(({ phase, method, disposition }) => ({ phase, method, disposition })),
    [
      { phase: "auth", method: "GET", disposition: "allowed-auth-preview" },
      { phase: "auth", method: "POST", disposition: "allowed-auth-preview" },
    ],
  );
  assert.deepEqual(f.envelope.receipt(), {
    format: "pool-observation-store-network-envelope-v1",
    authPreviewRequests: { createSubdomainEdgePreviewSession: 1, createScriptEdgePreview: 1 },
    authPreviewPosts: 1,
    otherCloudflareMutations: 0,
    blockedMutations: 0,
  });
  // Native adoption writes State, which is a separate authenticated API from Cloudflare management.
  await f.envelope.fetch("https://state.example.test/state/stacks/basalt", {
    method: "PUT",
    body: "native-state",
  });
  await assert.rejects(
    f.envelope.fetch(`${prefix}scripts/alchemy-state-store/edge-preview`, { method: "POST" }),
    /request-refused/,
  );
  assert.equal(f.sent.length, 3);
  assert.equal(f.envelope.receipt().blockedMutations, 1);
  assert.equal(f.envelope.receipt().otherCloudflareMutations, 0);
});

for (const phase of ["closed", "auth", "operation"])
  test(`global ${phase} guard refuses mutations outside the exact State-auth shapes before the wire`, async () => {
    for (const [method, url] of [
      ["POST", `${prefix}subdomain/edge-preview`],
      ["POST", `${prefix}scripts/another-worker/edge-preview`],
      ["POST", `${prefix}scripts/alchemy-state-store/edge-preview?extra=1`],
      ["POST", `${prefix}scripts/alchemy-state-store/versions`],
      ["POST", `https://api.cloudflare.com/client/v4/accounts/${account}/secrets_store/stores`],
      ["PUT", `${prefix}scripts/alchemy-state-store`],
      ["PATCH", `${prefix}scripts/alchemy-state-store`],
      ["DELETE", `${prefix}scripts/alchemy-state-store`],
      ["GET", `${prefix.replace(account, "2".repeat(32))}subdomain/edge-preview`],
    ]) {
      const f = fixture();
      if (phase !== "closed") f.envelope.beginAuth();
      if (phase === "operation") f.envelope.endAuth();
      await assert.rejects(f.envelope.fetch(url!, { method }), /request-refused/);
      assert.equal(f.sent.length, 0);
      assert.equal(f.log[0]!.disposition, "blocked");
      assert.throws(f.envelope.assertClean, /envelope-violated/);
      if (phase === "auth") assert.throws(f.envelope.endAuth, /envelope-violated/);
      await assert.rejects(
        f.envelope.fetch(`${prefix}subdomain`, { method: "GET" }),
        /envelope-violated/,
      );
      assert.equal(f.sent.length, 0);
    }
  });

test("auth-preview requests cannot escape their phase or exceed the bounded request budget", async () => {
  for (const method of ["GET", "POST"]) {
    const path =
      method === "GET" ? "subdomain/edge-preview" : "scripts/alchemy-state-store/edge-preview";
    for (const finished of [false, true]) {
      const f = fixture();
      if (finished) {
        f.envelope.beginAuth();
        f.envelope.endAuth();
      }
      await assert.rejects(f.envelope.fetch(prefix + path, { method }), /request-refused/);
      assert.equal(f.sent.length, 0);
    }
  }
  const f = fixture();
  f.envelope.beginAuth();
  for (let count = 0; count < 8; count++) await f.envelope.fetch(`${prefix}subdomain/edge-preview`);
  await assert.rejects(
    f.envelope.fetch(`${prefix}scripts/alchemy-state-store/edge-preview`, { method: "POST" }),
    /request-refused/,
  );
  assert.equal(f.sent.length, 8);
  assert.equal(f.envelope.receipt().authPreviewPosts, 0);
  assert.throws(f.envelope.endAuth, /envelope-violated/);
});

test("absolute DNS aliases cannot bypass the global mutation guard or its receipt", async () => {
  for (const phase of ["closed", "auth", "operation"])
    for (const host of ["api.cloudflare.com.", "API.CLOUDFLARE.COM.", "api.cloudflare.com.."])
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const f = fixture();
        if (phase !== "closed") f.envelope.beginAuth();
        if (phase === "operation") f.envelope.endAuth();
        const url = `${prefix.replace("api.cloudflare.com", host)}scripts/alchemy-state-store/edge-preview`;
        await assert.rejects(f.envelope.fetch(url, { method }), /request-refused/);
        assert.equal(f.sent.length, 0);
        assert.equal(f.log[0]!.disposition, "blocked");
        assert.equal(f.envelope.receipt().blockedMutations, 1);
        assert.equal(f.envelope.receipt().otherCloudflareMutations, 0);
      }
});

test("concurrent auth requests cannot outrun the global budget", async () => {
  const f = fixture();
  f.envelope.beginAuth();
  const attempts = await Promise.allSettled(
    Array.from({ length: 12 }, () => f.envelope.fetch(`${prefix}subdomain/edge-preview`)),
  );
  assert.ok(attempts.some((attempt) => attempt.status === "rejected"));
  assert.ok(f.sent.length <= 8);
  assert.throws(f.envelope.endAuth, /envelope-violated/);
});

test("a logged auth request cannot be sent after its phase closes", async () => {
  let acknowledgeLog: () => void = () => {};
  let releaseLog: () => void = () => {};
  const logged = new Promise<void>((resolve) => {
    acknowledgeLog = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseLog = resolve;
  });
  let sent = 0;
  const envelope = observationStoreEnvelope(
    account,
    async () => {
      acknowledgeLog();
      await release;
    },
    async () => {
      sent++;
      return Response.json({});
    },
  );
  envelope.beginAuth();
  const pending = envelope.fetch(`${prefix}scripts/alchemy-state-store/edge-preview`, {
    method: "POST",
  });
  await logged;
  envelope.endAuth();
  releaseLog();
  await assert.rejects(pending, /auth-phase-ended-before-send/);
  assert.equal(sent, 0);
  assert.equal(envelope.receipt().authPreviewPosts, 0);
  assert.equal(envelope.receipt().otherCloudflareMutations, 0);
});
