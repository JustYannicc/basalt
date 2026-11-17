import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cause, Effect, Exit, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { uploadVersion } from "./cloudflare.ts";
import { fixture } from "./test/deploy-stack-fixture.ts";
import { BarrierRefusal } from "./manifest.ts";
import { ReleaseOperationFailure } from "./operation-failure.ts";
import { uploadFailure, uploadResponseDiagnostic } from "./upload-failure.ts";

const consumed = {
  errors: [{ code: 100312, message: "Completion token has already been consumed" }],
};

/** Cloudflare's observed behaviour: a completion token redeems once; a second redeem is 400/100312. */
function cloudflare() {
  const redeemed: (string | null)[] = [];
  const client = HttpClient.make((request) => {
    const body = request.body;
    assert.equal(body._tag, "FormData");
    const metadata: { assets?: { jwt?: string } } = JSON.parse(
      String(body.formData.get("metadata")),
    );
    const token = metadata.assets?.jwt ?? null;
    const reused = token !== null && redeemed.includes(token);
    redeemed.push(token);
    const response = reused
      ? Response.json({ success: false, ...consumed }, { status: 400 })
      : Response.json({
          success: true,
          result: { id: `version-${redeemed.length}`, startup_time_ms: 325 },
        });
    return Effect.succeed(HttpResponse.fromWeb(request, response));
  });
  const upload: typeof uploadVersion = (worker, assetsJwt) =>
    uploadVersion(worker, assetsJwt).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(
        Credentials,
        Effect.succeed({
          type: "apiToken",
          apiToken: Redacted.make("synthetic-token"),
          apiBaseUrl: "https://api.cloudflare.invalid",
        }),
      ),
    );
  return { redeemed, upload };
}

test("every startup sample of an asset Worker redeems its own completion token", async () => {
  const provider = cloudflare();
  let sessions = 0;
  const proof = fixture({
    upload: (worker, assetsJwt) =>
      worker.id === "Api"
        ? provider.upload(worker, assetsJwt)
        : Effect.succeed({ versionId: `accepted-${worker.id}`, startupTimeMs: 100 }),
    assets: { renewAssets: () => Effect.sync(() => `fresh-token-Api-${++sessions}`) },
  });
  await Effect.runPromise(proof.effect);
  assert.deepEqual(provider.redeemed, ["plan-token-Api", "fresh-token-Api-1"]);
  assert.equal(sessions, 1);
  const receipt = proof.receipts.at(-1)!;
  assert.equal(receipt.phase, "complete");
  assert.deepEqual(
    receipt.startupMeasurements
      ?.filter((item) => item.worker === "Api")
      .map((item) => item.versionId),
    ["version-1", "version-2"],
  );
});

test("a renewed session that repeats a redeemed token refuses before sending the upload", async () => {
  const provider = cloudflare();
  const proof = fixture({
    upload: provider.upload,
    assets: { renewAssets: () => Effect.succeed("plan-token-Api") },
  });
  const exit = await Effect.runPromiseExit(proof.effect);
  assert.ok(Exit.isFailure(exit));
  const failure = Cause.squash(exit.cause);
  assert.ok(failure instanceof BarrierRefusal);
  assert.equal(failure.reason, "asset-completion-token-not-renewed");
  assert.equal(failure.worker, "Api");
  assert.deepEqual(provider.redeemed, ["plan-token-Api"]);
  assert.deepEqual(proof.receipts.at(-1)?.activated, []);
  assert.deepEqual(proof.receipts.at(-1)?.pendingUpload, { worker: "Api" });
});

test("an asset Worker without a renewable session refuses its second sample unsent", async () => {
  const provider = cloudflare();
  const proof = fixture({ upload: provider.upload, assets: {} });
  const exit = await Effect.runPromiseExit(proof.effect);
  assert.ok(Exit.isFailure(exit));
  const failure = Cause.squash(exit.cause);
  assert.ok(failure instanceof BarrierRefusal);
  assert.equal(failure.reason, "asset-upload-session-unavailable");
  assert.deepEqual(provider.redeemed, ["plan-token-Api"]);
  assert.deepEqual(proof.receipts.at(-1)?.activated, []);
});

test("a failed session renewal names its operation and activates nothing", async () => {
  const provider = cloudflare();
  const proof = fixture({
    upload: provider.upload,
    assets: {
      renewAssets: () =>
        Effect.fail(Object.assign(new Error("session refused"), { _tag: "Unauthorized" })).pipe(
          Effect.orDie,
        ),
    },
  });
  const exit = await Effect.runPromiseExit(proof.effect);
  assert.ok(Exit.isFailure(exit));
  const failure = Cause.squash(exit.cause);
  assert.ok(failure instanceof ReleaseOperationFailure);
  assert.equal(failure.operation, "renew-asset-upload-session");
  assert.equal(failure.worker, "Api");
  assert.deepEqual(provider.redeemed, ["plan-token-Api"]);
  assert.deepEqual(proof.receipts.at(-1)?.activated, []);
});

test("Workers without assets upload their frozen metadata without any token", async () => {
  const provider = cloudflare();
  const proof = fixture({
    upload: provider.upload,
    assets: undefined,
  });
  await Effect.runPromise(proof.effect);
  assert.deepEqual(provider.redeemed, [null, null, null, null]);
});

test("Cloudflare 100312 is classified as a consumed asset completion token", () => {
  const diagnostic = uploadResponseDiagnostic(400, consumed);
  assert.equal(diagnostic.messageClass, "asset-completion-token-consumed");
  const changed = new Map(
    uploadFailure(new Error("sdk"), "Api", diagnostic).delta?.changed.map((row) => [
      row.path,
      "new" in row ? row.new : null,
    ]),
  );
  assert.equal(changed.get("$upload.codes"), "100312");
  assert.equal(changed.get("$upload.messageClass"), "asset-completion-token-consumed");
});

test("the actual Alchemy provider renews the captured Worker's own asset session after reconcile returns", (context) => {
  const scratch = mkdtempSync(join(tmpdir(), "asset-renewal-"));
  context.after(() => rmSync(scratch, { recursive: true, force: true }));
  const result = spawnSync(
    "bun",
    [fileURLToPath(new URL("./test/asset-renewal-proof.mjs", import.meta.url)), scratch],
    {
      env: {
        PATH: process.env.PATH,
        CI: "true",
        DO_NOT_TRACK: "1",
        ALCHEMY_HOME: join(scratch, "auth"),
        TMPDIR: scratch,
      },
      encoding: "utf8",
      timeout: 40_000,
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const line = result.stdout.split("\n").find((line) => line.startsWith("__PROOF__"));
  assert.ok(line, "Asset renewal proof must emit its result");
  const proof: {
    frozen: string;
    renewed: string[];
    manifests: unknown[];
    calls: string[];
  } = JSON.parse(line.slice("__PROOF__".length));
  assert.equal(proof.frozen, "completion-1");
  assert.deepEqual(proof.renewed, ["completion-2", "completion-3"]);
  assert.equal(proof.manifests.length, 3);
  for (const manifest of proof.manifests) assert.deepEqual(manifest, proof.manifests[0]);
  // Files already stored are never sent again; renewal opens sessions only.
  assert.equal(proof.calls.filter((call) => call === "POST:/assets/upload").length, 1);
});
