import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureEuNamespace } from "./ensure-artifacts.ts";

test("refuses an existing namespace outside the EU without mutating it", async () => {
  await assert.rejects(
    () =>
      ensureEuNamespace(async (method) => {
        assert.equal(method, "GET");
        return { result: [{ namespace: "basalt-production-apps", jurisdiction: "unrestricted" }] };
      }, "basalt-production-apps"),
    /immutable EU jurisdiction/,
  );
});

test("checks every page before creating a missing EU namespace", async () => {
  const calls: string[] = [];
  await ensureEuNamespace(async (method, cursor) => {
    calls.push(`${method}:${cursor ?? ""}`);
    if (method === "POST") return { namespace: "basalt-production-apps", jurisdiction: "eu" };
    return cursor ? { result: [] } : { result: [], result_info: { cursor: "next" } };
  }, "basalt-production-apps");
  assert.deepEqual(calls, ["GET:", "GET:next", "POST:"]);
});
