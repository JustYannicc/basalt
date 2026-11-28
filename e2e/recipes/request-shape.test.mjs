import assert from "node:assert/strict";
import { test } from "node:test";
import { requestShape } from "./request-shape.mjs";

test("a request kept as evidence names its method, path and age, never its host, query or identifiers", () => {
  assert.deepEqual(
    requestShape(
      "GET",
      "https://app.example.test/api/organizations/X0kN7vcOI7N3jGS0TwX1y6aI45jE3XgN/resources/accounts?after=12&token=secret",
      30_412,
    ),
    { method: "GET", path: "/api/organizations/:organization/resources/accounts", openMs: 30_412 },
  );
  assert.deepEqual(
    requestShape(
      "GET",
      "http://127.0.0.1:4100/api/organizations/zwbyC97mNkVbXRueb4osV4rc8ofv6mcH/apps/app_79b23020-9af4-408d-abaa-8b411d0c6e1f/pool-usage/series#range",
      12,
    ).path,
    "/api/organizations/:organization/apps/:id/pool-usage/series",
  );
  // A slug after `/org/` and any segment carrying an identifier are cut; plain words stay.
  assert.equal(
    requestShape("POST", "https://h.test/org/acme-corp/v1/reads/acc_1f2e3d4c5b6a", 0).path,
    "/org/:organization/v1/reads/:id",
  );
  assert.equal(
    requestShape("GET", "https://h.test/pool-credit-policy", 1).path,
    "/pool-credit-policy",
  );
});
