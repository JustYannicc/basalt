import assert from "node:assert/strict";
import { test } from "node:test";
import { publishAccountObservations, observationPublishPath } from "./account-observation-publish.ts";
import { accountAcquisitionPrefix } from "./account-acquisition-contract.ts";
import { openEnvelope } from "./token.ts";

test("the alarm signs a bounded private refresh request and reports failed publication", async () => {
  const key = "ab".repeat(32), now = Date.parse("2030-01-01T00:00:00Z");
  let status = 204;
  const service = { fetch: async (url: string, init: RequestInit) => {
    assert.equal(new URL(url).pathname, observationPublishPath);
    assert.equal(init.method, "POST");
    const body = JSON.parse(String(init.body)) as { envelope: string };
    assert.deepEqual(await openEnvelope(key, accountAcquisitionPrefix, body.envelope), {
      action: "refresh-observations", at: now, expiresAt: now + 30_000,
    });
    return new Response(null, { status });
  } };
  await publishAccountObservations(service, key, now);
  status = 503;
  await assert.rejects(publishAccountObservations(service, key, now), /publication failed/);
});
