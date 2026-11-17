// Regression: script-settings-drift
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { Credentials, apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import { preparedUpload } from "./fixture.ts";
import { freezeUpload } from "./version-request.ts";

const placement = { region: "aws:eu-central-1" };

// Alchemy hands the barrier the SDK's decoded settings, where a region placement reads back as a
// numeric target; the declaration still says region. Comparing them raw refused an unchanged Api.
const apiUpload = async () => {
  const upload = preparedUpload("Api");
  const input = { ...upload, props: { placement }, previousProps: { placement } };
  input.request.metadata.placement = placement;
  input.previousSettings = await Effect.runPromise(
    Workers.getScriptScriptAndVersionSetting({ accountId: "fixture", scriptName: "Api" }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                success: true,
                result: {
                  ...upload.previousSettings,
                  placement: { mode: "targeted", target: [39] },
                  logpush: false,
                  tail_consumers: [],
                },
              }),
            ),
          ),
        ),
      ),
      Effect.provideService(
        Credentials,
        Effect.succeed(apiTokenCredentials({ apiToken: "synthetic" })),
      ),
    ),
  );
  return input;
};

const activeVersion = (region: string) => [
  { id: "active", placement: { mode: "targeted", target: [{ id: 39, region, type: "region" }] } },
];

const freezeRefusal = async (region: string) => {
  const input = await apiUpload();
  // Untyped so the same call also runs against the pre-fix two-argument barrier for the RED proof.
  const freeze = freezeUpload as (...args: unknown[]) => Promise<unknown>;
  return freeze(input, [{ versionId: "active", percentage: 100 }], activeVersion(region)).then(
    () => undefined,
    (error: { reason?: string }) => error.reason ?? String(error),
  );
};

test("an Api region placement that the active version resolves to the same target is not drift", async () => {
  assert.equal(await freezeRefusal("aws:eu-central-1"), undefined);
});

test("an Api numeric placement target that resolves to another region still refuses as drift", async () => {
  assert.equal(await freezeRefusal("aws:us-east-1"), "script-settings-drift");
});
