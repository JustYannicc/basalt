import assert from "node:assert/strict";
import { Effect } from "effect";
import { appsManifest } from "../.upstream/e2e/support/apps-release.ts";

/** Run an unrelated catalog app with extra token metadata through real sign-in and health. */
export const verifyMiroOAuth = ({ request, prefix, fixtureOrigin, source }) =>
  Effect.gen(function* () {
    const app = yield* request("POST", `${prefix}/apps/deploy`, {
      name: "Miro OAuth health proof",
      files: [
        ...source.files
          .filter((file) => file.path !== "package.json")
          .map((file) => ({
            ...file,
            content: file.content
              .replaceAll("https://api.miro.com", fixtureOrigin)
              .replaceAll("https://miro.com", fixtureOrigin)
              .replaceAll(
                'hosts: ["api.miro.com"]',
                `hosts: [${JSON.stringify(new URL(fixtureOrigin).host)}]`,
              ),
          })),
        appsManifest,
      ],
    });
    const connection = yield* request(
      "POST",
      `${prefix}/apps/${app.id}/accounts/user/miro/connections`,
      {},
    );
    const signIn = yield* request("POST", `${prefix}/connections/${connection.id}/oauth/start`, {
      method: "oauth",
      client: { clientId: "synthetic-miro-client", clientSecret: "synthetic-miro-secret" },
    });
    const authorization = new URL(signIn.authorizationUrl);
    authorization.searchParams.set("fixture_user", "synthetic-miro");
    const consent = yield* Effect.promise(() => fetch(authorization, { redirect: "manual" }));
    assert.equal(consent.status, 302);
    const saved = yield* request("POST", `${prefix}/connections/${connection.id}/oauth/complete`, {
      callbackUrl: consent.headers.get("location"),
    });
    const health = yield* request("POST", `${prefix}/accounts/${saved.id}/health`);
    return { check: health.apps.find((entry) => entry.app === app.id)?.check, info: health.info };
  });
