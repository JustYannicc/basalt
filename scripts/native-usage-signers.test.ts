import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeTunnelFrame } from "../clients/contracts/tunnel.ts";
import { isPublicModelPath } from "../src/pool/lifecycle.ts";
import { nativeUsagePath } from "../src/pool/native-usage-contract.ts";

// #1659: the device usage read has no per-device bound yet, so no device-facing signer may cover
// its path. When one has to, bound the read first (#1659), then change this test.
test("no device-facing signer covers the device usage read until #1659 bounds it", () => {
  assert.equal(
    isPublicModelPath(nativeUsagePath),
    false,
    "the router signs public model paths; the device usage read must not become one before #1659",
  );
  const open = (method: string, path: string) =>
    JSON.stringify({
      v: 1,
      type: "open",
      id: 1,
      operation: { service: "models", method, path, transport: "http" },
      headers: {},
    });
  // The probe is sound: the tunnel opens a real model path.
  assert.doesNotThrow(() => decodeTunnelFrame(open("GET", "/v1/models"), "client"));
  for (const method of ["GET", "POST"])
    assert.throws(
      () => decodeTunnelFrame(open(method, nativeUsagePath), "client"),
      `the tunnel must not open ${method} ${nativeUsagePath} before #1659`,
    );
});
