import assert from "node:assert/strict";
import { adaptProviderAppFiles } from "./provider-source.mjs";

/** Keep the GitLab.com site identity while the external OAuth fixture owns transport. */
export function proveGitLabLegacy({ Effect, request, checked, actors, prefix, callback, catalog, fixtures, appsVersion, prove }) {
  return Effect.gen(function* () {
    const site = fixtures.site("legacy");
    const filesAtFixture = (files) => adaptProviderAppFiles(files, appsVersion, "gitlab").files.map(file =>
      ["index.ts", "openapi.ts"].includes(file.path) ? {
        ...file,
        content: file.content.replaceAll("https://gitlab.com/", site.origin + "/")
          .replaceAll('const site = account.site ?? "https://gitlab.com";', `const site = ${JSON.stringify(site.origin)};`)
          .replaceAll('"gitlab.com"', JSON.stringify(site.host)),
      } : file);
    const deploy = (files, name) => request(actors.owner, "POST", prefix + "/apps/deploy", { name, files });
    const old = checked(yield* deploy(filesAtFixture(catalog.published.files), "Legacy GitLab OAuth fixture"), 200, "Deploy site-less legacy OAuth declaration");
    const connect = (app, account, origin) => request(actors.owner, "POST", prefix + "/apps/" + app.id + "/accounts/user/gitlab/connections", {
      destination: { kind: "personal" },
      ...(account === undefined ? {} : { account }),
      ...(origin === undefined ? {} : { site: origin }),
    });
    const complete = (connection, client) => Effect.gen(function* () {
      const started = checked(yield* request(actors.owner, "POST", prefix + "/connections/" + connection.id + "/oauth/start", {
        method: "oauth", label: "Synthetic legacy GitLab OAuth",
        ...(client === undefined ? {} : { client }),
      }), 200, "Start legacy OAuth with its own client");
      const authorization = new URL(started.authorizationUrl);
      assert.equal(authorization.origin, site.origin);
      assert.equal(started.redirectUri, callback);
      const response = yield* Effect.promise(() => fetch(authorization, { redirect: "manual" }));
      assert.equal(response.status, 302);
      const callbackUrl = response.headers.get("location");
      assert.ok(callbackUrl);
      return checked(yield* request(actors.owner, "POST", prefix + "/connections/" + connection.id + "/oauth/complete", { callbackUrl }), 200, "Complete legacy OAuth callback");
    });
    const first = checked(yield* connect(old), 200, "Create legacy OAuth connection");
    const account = yield* complete(first, site.client);
    assert.equal(account.method, "oauth");
    assert.equal(account.site ?? null, null);
    const current = checked(yield* deploy(filesAtFixture(catalog.source.files), "Default-site GitLab OAuth fixture"), 200, "Deploy the new default-site declaration");
    assert.equal(current.requirements.accounts.gitlab.provider, old.requirements.accounts.gitlab.provider);
    assert.equal(current.requirements.accounts.gitlab.definition.site.origin, "https://gitlab.com");
    const before = fixtures.observations.length;
    const moved = yield* connect(current, account.id, fixtures.site("instance-a").origin);
    prove(moved.status === 422, "A site-less legacy account cannot reconnect away from its declared default");
    assert.equal(fixtures.observations.length, before);
    const reconnect = checked(yield* connect(current, account.id), 200, "Reconnect legacy OAuth at its default site");
    const saved = yield* complete(reconnect);
    const read = checked(yield* request(actors.owner, "GET", prefix + "/accounts/" + account.id), 200, "Read migrated legacy OAuth account");
    assert.equal(saved.id, account.id);
    assert.equal(read.account.id, account.id);
    assert.equal(saved.site, "https://gitlab.com");
    assert.equal(read.account.site, "https://gitlab.com");
    prove(true, "A completed OAuth reconnect preserves the legacy account ID and persists https://gitlab.com");
    return { accountIdPreserved: true, defaultSitePersisted: true, canonicalDefaultOrigin: true };
  });
}
