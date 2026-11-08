import assert from "node:assert/strict";
import { Effect, Layer, Redacted } from "effect";
import * as Provider from "alchemy/Provider";
import { Bucket, ProviderLive } from "alchemy/Cloudflare/R2";
import { CloudflareEnvironment, Providers } from "alchemy/Cloudflare";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";

export const nativeBucketProvider = (current: () => Bucket["Attributes"] | undefined) =>
  Layer.effect(Providers, Provider.collection([Bucket])).pipe(
    Layer.provide(ProviderLive()),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(
          Credentials,
          Effect.succeed({
            type: "apiToken",
            apiToken: Redacted.make("synthetic-never-sent"),
            apiBaseUrl: "https://fixture.invalid",
          }),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request, url) =>
            Effect.sync(() => {
              const stored = current();
              assert.equal(request.method, "GET");
              assert.ok(url.pathname.includes("/r2/buckets/"));
              return HttpResponse.fromWeb(
                request,
                stored
                  ? Response.json({
                      success: true,
                      errors: [],
                      messages: [],
                      result: {
                        name: stored.bucketName,
                        jurisdiction: stored.jurisdiction,
                        storage_class: stored.storageClass,
                      },
                    })
                  : Response.json(
                      {
                        success: false,
                        errors: [
                          {
                            code: 10006,
                            message: "The specified bucket does not exist.",
                          },
                        ],
                      },
                      { status: 404 },
                    ),
              );
            }),
          ),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        CloudflareEnvironment,
        Effect.succeed({
          type: "apiToken",
          accountId: "fixture",
          apiToken: Redacted.make("synthetic-never-sent"),
          source: { type: "env" },
        }),
      ),
    ),
  );
