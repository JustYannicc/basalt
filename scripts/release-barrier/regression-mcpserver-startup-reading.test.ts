// Regression: mcpserver-startup-reading
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Exit, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { uploadVersion } from "./cloudflare.ts";
import { fixture } from "./test/deploy-stack-fixture.ts";

/**
 * Production refused a release when McpServer's first upload measured 900 ms against the 750 ms
 * ceiling: the re-measure re-sent the plan-time asset completion token and Cloudflare answered
 * 400/100312. Cloudflare's startup figure is noisy for identical bytes, so one slow reading must
 * cost a re-measure, never the release.
 */
function cloudflare(startupMs: readonly number[]) {
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
      ? Response.json(
          {
            success: false,
            errors: [{ code: 100312, message: "Completion token has already been consumed" }],
          },
          { status: 400 },
        )
      : Response.json({
          success: true,
          result: {
            id: `mcp-version-${redeemed.length}`,
            startup_time_ms: startupMs[redeemed.length - 1] ?? 300,
          },
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

test("one McpServer startup reading over the ceiling re-measures with fresh asset tokens and releases", async () => {
  const provider = cloudflare([900, 300, 310]);
  let sessions = 0;
  const proof = fixture({
    extraWorkers: ["McpServer"],
    upload: (worker, assetsJwt) =>
      worker.id === "McpServer"
        ? provider.upload(worker, assetsJwt)
        : Effect.succeed({ versionId: `accepted-${worker.id}`, startupTimeMs: 100 }),
    assets: {
      worker: "McpServer",
      renewAssets: () => Effect.sync(() => `fresh-token-McpServer-${++sessions}`),
    },
  });
  const exit = await Effect.runPromiseExit(proof.effect);
  const receipt = proof.receipts.at(-1)!;
  assert.equal(
    receipt.failure?.reason,
    undefined,
    `the release was refused: ${JSON.stringify(receipt.failure)}`,
  );
  assert.ok(Exit.isSuccess(exit));
  // Every re-measure redeemed its own token; none was sent twice.
  assert.deepEqual(provider.redeemed, [
    "plan-token-McpServer",
    "fresh-token-McpServer-1",
    "fresh-token-McpServer-2",
  ]);
  assert.equal(receipt.phase, "complete");
  assert.deepEqual(
    receipt.startupMeasurements
      ?.filter((item) => item.worker === "McpServer")
      .map((item) => item.startupTimeMs),
    [900, 300, 310],
  );
  // The slow reading is kept as evidence but never admits the Worker.
  assert.deepEqual(
    receipt.accepted
      .filter((item) => item.worker === "McpServer")
      .map((item) => item.startupTimeMs),
    [310],
  );
});
