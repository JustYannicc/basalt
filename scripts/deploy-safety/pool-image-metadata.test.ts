import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { capturePoolImage } from "./capture-pool-image.ts";
import { inspectPoolImage } from "./pool-image-metadata.ts";
import { poolImageReceipt } from "./pool-image.ts";
import type { Fetcher } from "./http.ts";

const credentials = { accountId: "fixture", apiToken: "synthetic-api-token" };
const hash = (bytes: string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function registry(
  options: {
    label?: string;
    architecture?: string;
    corrupt?: "manifest" | "config";
    index?: "unique" | "ambiguous";
    credentialStatus?: number;
    manifestStatus?: number;
    configStatus?: number;
  } = {},
) {
  const config = JSON.stringify({
    os: "linux",
    architecture: options.architecture ?? "amd64",
    config: {
      Labels:
        options.label === ""
          ? {}
          : {
              "io.signalbox.pool.oauth-completion-receipts": options.label ?? "1",
            },
    },
  });
  const configDigest = hash(config);
  const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: configDigest } });
  const childDigest = hash(manifest);
  const index = JSON.stringify({
    schemaVersion: 2,
    manifests: Array.from({ length: options.index === "ambiguous" ? 2 : 1 }, () => ({
      digest: childDigest,
      platform: { os: "linux", architecture: "amd64" },
    })),
  });
  const digest = hash(options.index ? index : manifest);
  const calls: string[] = [];
  const fetcher: Fetcher = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    assert.equal(init?.redirect, "error");
    if (url.hostname === "api.cloudflare.com") {
      assert.equal(
        url.pathname,
        "/client/v4/accounts/fixture/containers/registries/registry.cloudflare.com/credentials",
      );
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-api-token");
      assert.deepEqual(JSON.parse(String(init.body)), {
        permissions: ["pull"],
        expiration_minutes: 60,
      });
      return Response.json(
        {
          success: true,
          errors: [],
          result: { username: "fixture", password: "synthetic-pull-token" },
        },
        { status: options.credentialStatus ?? 201 },
      );
    }
    assert.equal(url.hostname, "registry.cloudflare.com");
    assert.equal(init?.method, "GET");
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      `Basic ${Buffer.from("fixture:synthetic-pull-token").toString("base64")}`,
    );
    const target = url.pathname;
    if (target === `/v2/fixture/pool/blobs/${configDigest}`)
      return new Response(options.corrupt === "config" ? `${config} ` : config, {
        status: options.configStatus ?? 200,
      });
    if (options.index && target === `/v2/fixture/pool/manifests/${digest}`)
      return new Response(index, { status: options.manifestStatus ?? 200 });
    assert.equal(target, `/v2/fixture/pool/manifests/${childDigest}`);
    return new Response(options.corrupt === "manifest" ? `${manifest} ` : manifest, {
      status: options.manifestStatus ?? 200,
    });
  };
  return {
    digest,
    configDigest,
    fetcher,
    calls,
    image: `registry.cloudflare.com/fixture/pool@${digest}`,
  };
}

test("capture accepts credential issuance HTTP 201 and writes digest-bound evidence for the release verifier", async () => {
  const fixture = registry({ index: "unique" });
  const directory = mkdtempSync(join(tmpdir(), "pool-publication-test-"));
  const file = join(directory, "receipt.json");
  const candidate = "a".repeat(40);
  try {
    await capturePoolImage(
      {
        BASALT_POOL_IMAGE_RECEIPT: file,
        GITHUB_SHA: candidate,
        CLOUDFLARE_ACCOUNT_ID: credentials.accountId,
        CLOUDFLARE_API_TOKEN: credentials.apiToken,
        POOL_APPLICATION_ID: "pool-app",
        POOL_WORKER_READY: "pool-worker",
        POOL_IMAGE_INPUT_HASH: "b".repeat(16),
        POOL_IMAGE_REF: fixture.image,
        POOL_IMAGE_DIGEST: fixture.digest,
      },
      fixture.fetcher,
    );
    const captured = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(poolImageReceipt(captured, candidate).configDigest, fixture.configDigest);
    assert.equal(captured.capabilityLabel, "1");
    assert.equal(captured.platform, "linux/amd64");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.throws(() => poolImageReceipt(captured, "c".repeat(40)), /candidate/);
    assert.equal(fixture.calls.length, 4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("only credential issuance accepts HTTP 201; immutable metadata still requires HTTP 200", async () => {
  const legacy = registry({ credentialStatus: 200 });
  assert.equal(
    (await inspectPoolImage(legacy.image, legacy.digest, credentials, legacy.fetcher)).configDigest,
    legacy.configDigest,
  );
  for (const options of [
    { credentialStatus: 202 },
    { manifestStatus: 201 },
    { configStatus: 201 },
  ]) {
    const fixture = registry(options);
    await assert.rejects(
      inspectPoolImage(fixture.image, fixture.digest, credentials, fixture.fetcher),
      /Pool image metadata request returned HTTP 20[12]/,
    );
  }
});

test("capture command exits unsuccessfully and reports the capture failure", () => {
  const result = spawnSync(
    process.execPath,
    [new URL("./capture-pool-image.ts", import.meta.url).pathname],
    {
      env: {},
      encoding: "utf8",
      timeout: 5_000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Pool image reference is outside its account or publication digest/);
});

test("capture writes no receipt for a wrong platform, absent capability, ambiguous index or mismatched bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pool-publication-refusal-"));
  const file = join(directory, "receipt.json");
  try {
    for (const options of [
      { architecture: "arm64" },
      { label: "" },
      { index: "ambiguous" as const },
      { corrupt: "manifest" as const },
      { corrupt: "config" as const },
    ]) {
      const fixture = registry(options);
      await assert.rejects(
        capturePoolImage(
          {
            BASALT_POOL_IMAGE_RECEIPT: file,
            CLOUDFLARE_ACCOUNT_ID: credentials.accountId,
            CLOUDFLARE_API_TOKEN: credentials.apiToken,
            POOL_IMAGE_REF: fixture.image,
            POOL_IMAGE_DIGEST: fixture.digest,
          },
          fixture.fetcher,
        ),
        /platform|label|unique|bytes differ/,
      );
      assert.equal(existsSync(file), false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("metadata inspection refuses foreign and mutable references before requesting credentials", async () => {
  const fixture = registry();
  for (const image of [
    fixture.image.replace("/fixture/", "/other/"),
    fixture.image.replace("registry.cloudflare.com", "untrusted.invalid"),
    "registry.cloudflare.com/fixture/pool:latest",
    fixture.image.replace("/pool@", "/../pool@"),
  ]) {
    await assert.rejects(
      inspectPoolImage(image, fixture.digest, credentials, fixture.fetcher),
      /reference|repository/,
    );
  }
  assert.deepEqual(fixture.calls, []);
  assert.equal(
    (await inspectPoolImage(fixture.image, fixture.digest, credentials, fixture.fetcher))
      .configDigest,
    fixture.configDigest,
  );
});
