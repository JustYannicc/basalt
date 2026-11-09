import assert from "node:assert/strict";
import { Effect, Layer, Redacted } from "effect";
import * as Provider from "alchemy/Provider";
import { Database, ProviderLive } from "alchemy/Cloudflare/D1";
import { CloudflareEnvironment, Providers } from "alchemy/Cloudflare";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";

export const nativeD1Provider = (current: () => Database["Attributes"] | undefined) =>
  Layer.effect(Providers, Provider.collection([Database])).pipe(
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
              assert.ok(url.pathname.includes("/d1/database"));
              const item = stored
                ? {
                    uuid: stored.databaseId,
                    name: stored.databaseName,
                    jurisdiction: stored.jurisdiction,
                  }
                : undefined;
              const list = url.pathname.endsWith("/database");
              return HttpResponse.fromWeb(
                request,
                !list && !stored
                  ? Response.json(
                      { success: false, errors: [{ code: 7404, message: "not found" }] },
                      { status: 404 },
                    )
                  : Response.json({
                      success: true,
                      errors: [],
                      messages: [],
                      result: list ? (item ? [item] : []) : item,
                    }),
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
