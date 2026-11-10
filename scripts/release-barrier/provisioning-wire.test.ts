import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpRequest from "effect/http/HttpClientRequest";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { provisioningFixture } from "./test/provisioning-fixtures.ts";
import { expectedApplicationRequest, singleFinalCreateClient } from "./provisioning-wire.ts";

function harness() {
  const fixture = provisioningFixture();
  let accepted = 0;
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      accepted++;
      return HttpResponse.fromWeb(request, Response.json({ synthetic: true }));
    }),
  );
  const gate = singleFinalCreateClient(
    client,
    fixture.manifest,
    fixture.namespaceId,
    fixture.enable,
    () => 100,
  );
  const url = `https://api.cloudflare.com/client/v4/accounts/${fixture.manifest.declaration.accountId}/containers/applications`;
  const post = (
    body = expectedApplicationRequest(fixture.manifest, fixture.namespaceId),
    target = url,
  ) => HttpRequest.post(target).pipe(HttpRequest.bodyJsonUnsafe(body));
  return { ...fixture, gate, url, post, accepted: () => accepted, client };
}

test("one exact attached POST is forwarded and a second mutation is refused", async () => {
  const h = harness();
  await Effect.runPromise(h.gate.execute(h.post()));
  await assert.rejects(
    Effect.runPromise(h.gate.execute(h.post())),
    /provisioning-provider-operation-refused/,
  );
  assert.equal(h.accepted(), 1);
});

test("namespace, configuration, account path and origin drift are refused before dispatch", async () => {
  const h = harness();
  const body = expectedApplicationRequest(h.manifest, h.namespaceId);
  for (const request of [
    h.post({ ...body, durable_objects: { namespace_id: "wrong-namespace" } }),
    h.post({ ...body, configuration: { ...body.configuration, image: "wrong-image" } }),
    h.post(body, h.url.replace("api.cloudflare.com", "fixture.invalid")),
    h.post(body, `${h.url}/other-application`),
    h.post(body, `${h.url}?force=true`),
    HttpRequest.make("DELETE")(h.url),
  ])
    await assert.rejects(
      Effect.runPromise(h.gate.execute(request)),
      /provisioning-(input-drift|provider-operation-refused)/,
    );
  assert.equal(h.accepted(), 0);
});

test("missing and expired enables refuse the exact POST", async () => {
  const h = harness();
  for (const enable of [undefined, { ...h.enable, expiresAt: 100 }]) {
    const gate = singleFinalCreateClient(h.client, h.manifest, h.namespaceId, enable, () => 100);
    await assert.rejects(
      Effect.runPromise(gate.execute(h.post())),
      /runtime-provisioning-not-enabled/,
    );
  }
  assert.equal(h.accepted(), 0);
});
