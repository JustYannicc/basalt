import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { capturePoolImage } from "./capture-pool-image.ts";
import { waitForPoolImage } from "./pool-image.ts";

const hash = (bytes: string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const config = JSON.stringify({
  os: "linux",
  architecture: "amd64",
  config: { Labels: { "io.signalbox.pool.oauth-completion-receipts": "1" } },
});
const configDigest = hash(config);
const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: configDigest } });
const digest = hash(manifest);
const image = `registry.cloudflare.com/fixture/pool@${digest}`;
const registry = async (input: unknown) => {
  const url = new URL(String(input));
  if (url.hostname === "api.cloudflare.com")
    return Response.json(
      { success: true, errors: [], result: { username: "fixture", password: "synthetic" } },
      { status: 201 },
    );
  if (url.pathname.endsWith(`/blobs/${configDigest}`)) return new Response(config);
  return new Response(manifest);
};
const candidate = "a".repeat(40);
const source = (file: string) => ({
  BASALT_POOL_IMAGE_RECEIPT: file,
  GITHUB_SHA: candidate,
  CLOUDFLARE_ACCOUNT_ID: "fixture",
  CLOUDFLARE_API_TOKEN: "synthetic-api-token",
  POOL_APPLICATION_ID: "root-app",
  POOL_WORKER_READY: "pool-worker",
  POOL_IMAGE_INPUT_HASH: "b".repeat(16),
  POOL_IMAGE_REF: image,
  POOL_IMAGE_DIGEST: digest,
});

test("each sequential release phase replaces its own publication receipt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "premortem-receipt-"));
  const file = join(directory, "receipt.json");
  try {
    await capturePoolImage(source(file), registry);
    await capturePoolImage({ ...source(file), POOL_IMAGE_INPUT_HASH: "c".repeat(16) }, registry);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).inputHash, "c".repeat(16));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the post-deploy image check follows the serving fleet after root retirement", async () => {
  const receipt = {
    candidate,
    applicationId: "root-app",
    accountId: "fixture",
    workerName: "pool-worker",
    inputHash: "b".repeat(16),
    platform: "linux/amd64",
    capabilityLabel: "1",
    configDigest,
    digest,
  };
  const calls: string[] = [];
  const cloudflare = async (input: unknown) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.hostname !== "api.cloudflare.com") return new Response(null, { status: 401 });
    if (url.pathname.endsWith("/instances-v2"))
      return Response.json({
        success: true,
        errors: [],
        result: url.pathname.includes("blue-app")
          ? [
              {
                id: "blue-runtime",
                application_id: "blue-app",
                image,
                status: { state: "running" },
              },
            ]
          : [],
        result_info: {},
      });
    if (url.pathname.endsWith("/settings"))
      return Response.json({
        success: true,
        errors: [],
        result: {
          bindings: [
            { name: "POOL_IMAGE_HASH", type: "plain_text", text: "b".repeat(16) },
            { name: "POOL_BLUE_APPLICATION_ID", type: "plain_text", text: "blue-app" },
            { name: "POOL_BLUE_IMAGE_HASH", type: "plain_text", text: "c".repeat(16) },
            { name: "POOL_GREEN_APPLICATION_ID", type: "plain_text", text: "green-app" },
            { name: "POOL_GREEN_IMAGE_HASH", type: "plain_text", text: "d".repeat(16) },
          ],
        },
      });
    return Response.json({
      success: true,
      errors: [],
      result: {
        id: url.pathname.split("/").at(-1),
        account_id: "fixture",
        configuration: { image },
      },
    });
  };
  let now = 0;
  const verified = await waitForPoolImage(
    receipt,
    candidate,
    { accountId: "fixture", apiToken: "synthetic-api-token" },
    "https://pool.fixture.invalid",
    cloudflare,
    // The production budget is 240 s at 5 s intervals; a virtual clock keeps the same 48 rounds fast.
    { now: () => now, sleep: async (ms: number) => void (now += ms) },
  );
  assert.deepEqual(verified.instances, ["blue-runtime"]);
  assert.ok(calls.some((path) => path.includes("green-app")));
});
