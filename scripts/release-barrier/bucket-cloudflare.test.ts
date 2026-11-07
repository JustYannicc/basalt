import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import {
  createDeclaredBucket,
  configureDeclaredBucket,
  readDeclaredBucket,
} from "./bucket-cloudflare.ts";
import type { BucketTarget } from "./declared-buckets.ts";
import { BarrierRefusal } from "./manifest.ts";

const target: BucketTarget = {
  accountId: "synthetic-account",
  bucketName: "synthetic-bucket",
  jurisdiction: "eu",
  storageClass: "Standard",
};
function sdk(
  options: {
    absent?: boolean;
    omitIdentity?: boolean;
    publicAccess?: boolean;
    lifecycle?: boolean;
    fail?: boolean;
  } = {},
) {
  const calls: string[] = [];
  let rules = options.lifecycle
    ? [
        {
          id: "abort",
          enabled: true,
          conditions: { prefix: "" },
          abort_multipart_uploads_transition: { condition: { type: "Age", max_age: 604800 } },
        },
      ]
    : [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      calls.push(`${request.method} ${url.pathname}`);
      assert.equal(request.headers["cf-r2-jurisdiction"], "eu");
      let result: unknown;
      if (options.fail)
        return HttpResponse.fromWeb(
          request,
          Response.json(
            { success: false, errors: [{ code: 10000, message: "private-provider-detail" }] },
            { status: 403 },
          ),
        );
      if (request.method === "POST") {
        assert.equal(url.pathname, "/client/v4/accounts/synthetic-account/r2/buckets");
        assert.equal(request.body._tag, "Uint8Array");
        assert.deepEqual(JSON.parse(Buffer.from(request.body.body).toString()), {
          name: target.bucketName,
          storageClass: "Standard",
        });
        result = { name: target.bucketName, jurisdiction: "eu", storage_class: "Standard" };
      } else if (request.method === "PUT") {
        assert.ok(url.pathname.endsWith("/lifecycle"));
        assert.equal(request.body._tag, "Uint8Array");
        assert.deepEqual(JSON.parse(Buffer.from(request.body.body).toString()), { rules: [] });
        rules = [];
        result = {};
      } else {
        assert.equal(request.method, "GET");
        if (url.pathname.endsWith("/domains/managed"))
          result = {
            bucketId: "synthetic-id",
            domain: "private.example",
            enabled: options.publicAccess ?? false,
          };
        else if (url.pathname.endsWith("/domains/custom")) result = { domains: [] };
        else if (url.pathname.endsWith("/cors")) result = { rules: [] };
        else if (url.pathname.endsWith("/lifecycle")) result = { rules };
        else {
          if (options.absent)
            return HttpResponse.fromWeb(
              request,
              Response.json(
                {
                  success: false,
                  errors: [{ code: 10006, message: "The specified bucket does not exist." }],
                },
                { status: 404 },
              ),
            );
          result = options.omitIdentity
            ? {}
            : {
                name: target.bucketName,
                jurisdiction: "eu",
                storage_class: "Standard",
                location: "weur",
              };
        }
      }
      return HttpResponse.fromWeb(
        request,
        Response.json({ success: true, errors: [], messages: [], result }),
      );
    }),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient | Credentials>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(
          Credentials,
          Effect.succeed({
            type: "apiToken",
            apiToken: Redacted.make("synthetic-never-sent"),
            apiBaseUrl: "https://api.cloudflare.com/client/v4",
          }),
        ),
      ),
    );
  return { calls, run };
}

test("the real R2 SDK creates EU Standard once and clears default lifecycle only through explicit configuration", async () => {
  const proof = sdk({ lifecycle: true });
  await proof.run(createDeclaredBucket(target));
  assert.equal(proof.calls.length, 1);
  await proof.run(configureDeclaredBucket(target));
  const value = await proof.run(readDeclaredBucket(target));
  assert.equal(value?.attributes.jurisdiction, "eu");
  assert.equal(value?.attributes.storageClass, "Standard");
  assert.equal(value?.publicAccess, false);
  assert.equal(proof.calls.filter((call) => call.startsWith("POST")).length, 1);
  assert.equal(proof.calls.filter((call) => call.startsWith("PUT")).length, 1);
});

for (const options of [{ omitIdentity: true }, { publicAccess: true }, { lifecycle: true }])
  test(`the real R2 read refuses ${JSON.stringify(options)} without changing policy`, async () => {
    const proof = sdk(options);
    await assert.rejects(proof.run(readDeclaredBucket(target)), (error: unknown) => {
      assert.ok(error instanceof BarrierRefusal);
      assert.ok(error.delta?.changed.length);
      return true;
    });
    assert.ok(proof.calls.every((call) => call.startsWith("GET")));
  });

test("the real R2 SDK makes no automatic retry after a rejected create", async () => {
  const proof = sdk({ fail: true });
  await assert.rejects(proof.run(createDeclaredBucket(target)));
  assert.equal(proof.calls.length, 1);
});

test("the real R2 SDK reports a missing bucket without adopting or writing", async () => {
  const proof = sdk({ absent: true });
  assert.equal(await proof.run(readDeclaredBucket(target)), undefined);
  assert.equal(proof.calls.length, 1);
  assert.ok(proof.calls[0]?.startsWith("GET"));
});
