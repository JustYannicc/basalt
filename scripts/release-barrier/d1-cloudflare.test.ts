import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import {
  createDeclaredD1,
  declaredD1Exists,
  preflightDeclaredD1,
  readDeclaredD1,
} from "./d1-cloudflare.ts";

const id = "11111111-1111-4111-8111-111111111111";
const target = {
  accountId: "synthetic-account",
  databaseName: "public-site-waitlist",
  jurisdiction: "eu" as const,
};
function sdk(
  options: {
    fail?: boolean;
    absent?: boolean;
    jurisdiction?: string;
    foreign?: boolean;
    missingUuid?: boolean;
    replication?: string;
    collisionOnSecondPage?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      calls.push(`${request.method} ${url.pathname}${url.search}`);
      if (options.fail)
        return HttpResponse.fromWeb(
          request,
          Response.json(
            {
              success: false,
              errors: [{ code: 10000, message: "private-provider-token-details" }],
            },
            { status: 403 },
          ),
        );
      let result: unknown;
      if (request.method === "POST") {
        assert.equal(url.pathname, "/client/v4/accounts/synthetic-account/d1/database");
        assert.equal(request.body._tag, "Uint8Array");
        assert.deepEqual(JSON.parse(Buffer.from(request.body.body).toString()), {
          name: target.databaseName,
          jurisdiction: "eu",
        });
        result = {
          ...(options.missingUuid ? {} : { uuid: id }),
          name: target.databaseName,
          jurisdiction: "eu",
        };
      } else {
        assert.equal(request.method, "GET");
        assert.equal(request.body._tag, "Empty");
        if (url.pathname.endsWith(`/database/${id}`)) {
          if (options.absent)
            return HttpResponse.fromWeb(
              request,
              Response.json(
                { success: false, errors: [{ code: 7404, message: "not found" }] },
                { status: 404 },
              ),
            );
          result = {
            uuid: options.foreign ? "22222222-2222-4222-8222-222222222222" : id,
            name: target.databaseName,
            jurisdiction: options.jurisdiction ?? "eu",
            read_replication: { mode: options.replication ?? "disabled" },
          };
        } else {
          assert.equal(url.pathname, "/client/v4/accounts/synthetic-account/d1/database");
          const page = Number(url.searchParams.get("page") ?? 1);
          result = options.collisionOnSecondPage
            ? page === 1
              ? [{ uuid: id, name: "unrelated" }]
              : [{ uuid: id, name: target.databaseName }]
            : [];
          return HttpResponse.fromWeb(
            request,
            Response.json({
              success: true,
              errors: [],
              messages: [],
              result,
              result_info: {
                page,
                per_page: 1,
                count: 1,
                total_count: options.collisionOnSecondPage ? 2 : 0,
                total_pages: options.collisionOnSecondPage ? 2 : 1,
              },
            }),
          );
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

test("D1 preflight is one body-free account list GET using the existing SDK credential", async () => {
  const proof = sdk();
  await proof.run(preflightDeclaredD1(target.accountId));
  assert.deepEqual(proof.calls, [
    "GET /client/v4/accounts/synthetic-account/d1/database?per_page=1",
  ]);
});
test("the D1 create sends only the exact reviewed name and jurisdiction once", async () => {
  const proof = sdk();
  assert.equal(await proof.run(createDeclaredD1(target)), id);
  assert.deepEqual(proof.calls, ["POST /client/v4/accounts/synthetic-account/d1/database"]);
});
for (const fail of ["permission", "missing-uuid"])
  test(`D1 ${fail} never retries POST`, async () => {
    const proof = sdk({ fail: fail === "permission", missingUuid: fail === "missing-uuid" });
    await assert.rejects(proof.run(createDeclaredD1(target)));
    assert.equal(proof.calls.length, 1);
  });
test("D1 name collision checks paginate instead of adopting", async () => {
  const proof = sdk({ collisionOnSecondPage: true });
  assert.equal(await proof.run(declaredD1Exists(target)), true);
  assert.equal(proof.calls.length, 2);
  assert.ok(proof.calls.every((call) => call.startsWith("GET ")));
});
for (const options of [{ jurisdiction: "default" }, { foreign: true }, { replication: "auto" }])
  test(`D1 readiness rejects provider identity or policy drift ${JSON.stringify(options)}`, async () => {
    const proof = sdk(options);
    await assert.rejects(
      proof.run(readDeclaredD1(target, id, "PublicSiteWaitlist")),
      /declared-d1-observation-mismatch/,
    );
    assert.equal(proof.calls.length, 1);
  });
test("a missing acknowledged D1 is observed without adoption or writes", async () => {
  const proof = sdk({ absent: true });
  assert.equal(await proof.run(readDeclaredD1(target, id)), undefined);
  assert.deepEqual(proof.calls, [`GET /client/v4/accounts/synthetic-account/d1/database/${id}`]);
});
