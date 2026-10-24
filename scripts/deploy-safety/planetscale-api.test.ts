import assert from "node:assert/strict";
import test from "node:test";
import { PlanetScaleApi } from "./planetscale-api.ts";

test("PlanetScale service-token request uses the pinned ID:token Authorization contract", async () => {
  let requestHeaders: Headers | undefined;
  let requestUrl = "";
  const api = new PlanetScaleApi(
    { organization: "basalt-org", tokenId: "fixture-service-id", token: "fixture-service-secret" },
    async (input, init) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      return Response.json({
        type: "list",
        current_page: 1,
        per_page: 100,
        next_page: null,
        total_count: 1,
        total_pages: 1,
        data: [{
          name: "basalt",
          kind: "postgresql",
          ready: true,
          default_branch: "main",
        }],
      });
    },
  );

  const databases = await api.listDatabases("basalt");
  assert.equal(databases.length, 1);
  assert.match(requestUrl, /^https:\/\/api\.planetscale\.com\/v1\/organizations\/basalt-org\/databases\?/);
  assert.equal(requestHeaders?.get("authorization"), "fixture-service-id:fixture-service-secret");
  assert.equal(requestHeaders?.get("authorization")?.startsWith("Bearer "), false);
});
