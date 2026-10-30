import assert from "node:assert/strict";
import { Effect } from "effect";
import { gitlabHostedClient } from "./gitlab-fixture.mjs";
import { adaptProviderAppFiles } from "./provider-source.mjs";
import { loadGitLabCatalogSource } from "./gitlab-catalog.mjs";
import { proveGitLabOAuth } from "./gitlab-oauth.mjs";
import { proveGitLabLegacy } from "./gitlab-legacy.mjs";


const shareApp = (request, checked, actor, prefix, app) =>
  Effect.gen(function* () {
    const path = prefix + "/apps/" + app.id;
    const access = checked(yield* request(actor, "GET", path + "/access"), 200, "Read GitLab app audience");
    checked(yield* request(actor, "PATCH", path + "/access", {
      revision: access.revision,
      audience: { kind: "everyone" },
    }), 200, "Share GitLab app within the synthetic organization");
    return { ...app, path };
  });

const connectPath = (appPath) => appPath + "/accounts/user/gitlab/connections";
const setupPath = (prefix, connectionId) =>
  prefix + "/connections/" + connectionId + "/oauth/oauth/setup";
const startPath = (prefix, connectionId) =>
  prefix + "/connections/" + connectionId + "/oauth/start";

/** Exercise the unmodified product catalog source through the real account, OAuth and app runtime. */
export function proveGitLab({
  Effect,
  request,
  checked,
  actors,
  prefix,
  target,
  callback,
  catalog,
  fixtures,
  mcp,
  call,
  record,
}) {
  return Effect.gen(function* () {
    const currentManifest = JSON.parse(catalog.source.files.find((file) => file.path === "package.json").content);
    const runtimeAppsVersion = currentManifest.dependencies.apps;
    const legacyFiles = adaptProviderAppFiles(catalog.published.files, runtimeAppsVersion, "gitlab").files;
    const legacy = checked(yield* request(actors.owner, "POST", prefix + "/apps/deploy", {
      name: "GitLab legacy account identity proof",
      files: legacyFiles,
    }), 200, "Deploy the previous GitLab package declaration");
    const legacyProvider = legacy.requirements?.accounts?.gitlab?.provider;
    assert.equal(typeof legacyProvider, "string", "Previous GitLab source omitted its provider ID");

    const deployed = checked(yield* request(actors.owner, "POST", prefix + "/apps/deploy", {
      name: "GitLab multi-instance proof",
      files: catalog.source.files,
    }), 200, "Deploy the exact site-aware catalog source");
    const currentProvider = deployed.requirements?.accounts?.gitlab?.provider;
    assert.equal(currentProvider, legacyProvider,
      "Adding the account-site rule must keep the existing GitLab provider ID");
    const app = yield* shareApp(request, checked, actors.owner, prefix, deployed);
    const accountPath = (id) => prefix + "/accounts/" + id;
    const observations = fixtures.observations;
    let checks = 0;
    const prove = (condition, operation) => {
      assert.ok(condition, operation);
      checks++;
      record("gitlab-runtime", { operation });
    };

    const siteA = fixtures.site("instance-a");
    const siteB = fixtures.site("instance-b");
    const unapproved = fixtures.site("unapproved");

    const legacyMigration = yield* proveGitLabLegacy({
      Effect, request, checked, actors, prefix, callback, catalog, fixtures,
      appsVersion: runtimeAppsVersion, prove,
    });
    const hostedConnection = checked(yield* request(actors.owner, "POST", connectPath(app.path), {
      destination: { kind: "personal" },
    }), 200, "Create a GitLab.com connection at the declared default");
    const hostedSetup = checked(yield* request(actors.owner, "GET", setupPath(prefix, hostedConnection.id)), 200, "Read hosted GitLab.com OAuth setup");
    assert.equal(hostedSetup.issuer, "https://gitlab.com/oauth/token");
    assert.equal(hostedSetup.mode, "automatic");
    const hostedStart = checked(yield* request(actors.owner, "POST", startPath(prefix, hostedConnection.id), {
      method: "oauth", label: "GitLab.com hosted selection",
    }), 200, "Start hosted GitLab.com OAuth without user credentials");
    const hostedAuthorization = new URL(hostedStart.authorizationUrl);
    assert.equal(hostedAuthorization.origin, "https://gitlab.com");
    assert.equal(hostedAuthorization.searchParams.get("client_id"), gitlabHostedClient.id);
    assert.equal(hostedAuthorization.searchParams.has("client_secret"), false);

    const deniedPrivateOrigin = yield* request(
      actors.owner,
      "POST",
      connectPath(app.path),
      { destination: { kind: "personal" }, site: unapproved.origin },
    );
    prove(deniedPrivateOrigin.status === 422,
      "A private origin outside the deployment's exact allowlist is refused");
    prove(unapproved.requests.length === 0,
      "An unapproved private origin receives no connection traffic");

    const oauthProof = yield* proveGitLabOAuth({
      Effect, request, checked, actors, prefix, app, callback, fixtures, siteA, siteB, prove,
    });
    const { accountA, accountB } = oauthProof;

    const patConnection = checked(yield* request(
      actors.member,
      "POST",
      connectPath(app.path),
      { destination: { kind: "personal" }, site: siteA.origin },
    ), 200, "Create a separate GitLab personal-token connection");
    const patAccount = checked(yield* request(
      actors.member,
      "POST",
      prefix + "/connections/" + patConnection.id + "/submit",
      {
        method: "token",
        label: "Synthetic GitLab PAT",
        fields: { token: siteA.patToken },
      },
    ), 200, "Save a GitLab PAT for instance A");
    prove(patAccount.id !== accountA.id && patAccount.site === siteA.origin,
      "A PAT account keeps its own instance origin and account ID");
    const patHealth = checked(
      yield* request(actors.member, "POST", accountPath(patAccount.id) + "/health"),
      200,
      "Health-check the GitLab PAT account",
    );
    assert.equal(patHealth.info?.externalId, "4101");
    const patRequest = observations.find((event) =>
      event.site === siteA.id && event.phase === "health" && event.authKind === "pat",
    );
    assert.ok(patRequest?.credentialSiteMatches,
      "GitLab PAT health must send PRIVATE-TOKEN only to its saved origin");

    const linkedMember = checked(
      yield* request(actors.member, "GET", app.path + "/accounts/user/gitlab"),
      200,
      "Read the caller's linked GitLab accounts",
    );
    const linkedIds = linkedMember.accounts
      .filter((entry) => entry.linked)
      .map((entry) => entry.account.id);
    assert.ok(linkedIds.includes(accountA.id));
    assert.ok(linkedIds.includes(patAccount.id));
    assert.equal(new Set(linkedIds).size, linkedIds.length);
    prove(true, "One person can keep distinct GitLab OAuth and PAT accounts");

    const members = [
      { actor: actors.member, site: siteA, account: accountA, marker: "synthetic_gitlab_instance-a_project" },
      { actor: actors.admin, site: siteB, account: accountB, marker: "synthetic_gitlab_instance-b_project" },
      { actor: actors.member, site: siteA, account: patAccount, marker: "synthetic_gitlab_instance-a_project" },
    ];
    const apiKeys = [];
    for (const actor of [actors.member, actors.admin]) {
      const issued = checked(yield* request(actor, "POST", "/api/auth/api-key/create", {
        name: "Synthetic GitLab runtime proof",
        metadata: { organization: actors.organization.id },
      }), 200, "Create an organization-pinned GitLab MCP token");
      apiKeys.push({ actor, id: issued.id, key: issued.key });
    }
    yield* Effect.addFinalizer(() =>
      Effect.forEach(apiKeys, ({ actor, id }) =>
        request(actor, "POST", "/api/auth/api-key/delete", { keyId: id }).pipe(Effect.ignore),
      ).pipe(Effect.as(undefined)),
    );
    const clients = new Map();
    for (const { actor, key } of apiKeys) {
      clients.set(actor, yield* Effect.acquireRelease(
        Effect.promise(() => mcp(target.metadata.origin, key)),
        (client) => Effect.promise(() => client.close()),
      ));
    }
    for (const item of members) {
      const client = clients.get(item.actor);
      const search = yield* Effect.promise(() =>
        call(client, "search", { query: app.slug }),
      );
      assert.equal(search.isError, false, "Native MCP search must find the GitLab app");
      const tool = search.structuredContent?.items?.find((entry) =>
        entry.path.endsWith(".getApiV4Projects"),
      );
      assert.ok(tool, "GitLab projects tool must come from the real catalog app");
      const result = yield* Effect.promise(() => call(client, "call", {
        calls: { path: tool.path, input: { accountId: item.account.id, input: {} } },
      }));
      const output = JSON.stringify(result.structuredContent ?? result.content ?? result);
      assert.equal(result.isError, false, "GitLab projects call must succeed");
      assert.ok(output.includes(item.marker), "GitLab API result must come from " + item.site.id);
      const apiEvent = observations.filter((event) =>
        event.site === item.site.id && event.phase === "api",
      ).at(-1);
      assert.equal(apiEvent?.credentialSiteMatches, true);
      assert.equal(apiEvent?.path, "/api/v4/projects");
      assert.equal(
        apiEvent?.authKind,
        item.account.id === patAccount.id ? "pat" : "oauth",
      );
      prove(true, "Native GitLab API call used the saved " + item.site.id + " account origin");
      const mutation = search.structuredContent?.items?.find((entry) =>
        entry.path.endsWith(".postApiV4Projects"),
      );
      assert.ok(mutation, "The synthetic GitLab write must use the catalog mutation wrapper");
      const writesBefore = item.site.requests.filter((event) =>
        event.method === "POST" && event.path === "/api/v4/projects",
      ).length;
      const write = yield* Effect.promise(() => call(client, "call", {
        calls: { path: mutation.path, input: { accountId: item.account.id, input: { body: { name: "Synthetic approval check" } } } },
      }));
      assert.notEqual(write.isError, true, "The approval request must be a successful MCP response");
      assert.equal(write.structuredContent?.status, "approval-required");
      assert.equal(typeof write.structuredContent.requestId, "string");
      assert.equal(write.structuredContent.invocation?.app, app.id);
      assert.equal(write.structuredContent.invocation?.tool, "postApiV4Projects");
      assert.equal(item.site.requests.filter((event) =>
        event.method === "POST" && event.path === "/api/v4/projects",
      ).length, writesBefore, "An unapproved GitLab mutation must not reach the provider");
      prove(true, "GitLab mutation approval blocks provider writes for " + item.site.id);
    }

    siteA.redirectHealthTo = unapproved.origin + "/api/v4/user";
    yield* request(actors.member, "POST", accountPath(patAccount.id) + "/health");
    siteA.redirectHealthTo = undefined;
    prove(unapproved.requests.length === 0,
      "A GitLab API redirect to an unapproved private origin is refused");

    const siteAEvents = observations.filter((event) => event.site === siteA.id);
    const siteBEvents = observations.filter((event) => event.site === siteB.id);
    prove(siteAEvents.some((event) => event.phase === "token_exchange") &&
      siteBEvents.some((event) => event.phase === "token_exchange"),
    "Both GitLab instances completed their own BYO OAuth exchange");
    prove(siteAEvents.every((event) => !event.sharedClientAttempt) &&
      siteBEvents.every((event) => !event.sharedClientAttempt),
    "The GitLab.com shared client secret never reaches either self-managed instance");
    return {
      checks,
      gitlabTwoOriginRuntime: true,
      gitlabHostedClientAtGitLabComOnly: true,
      gitlabLegacyAccountIdPreserved: legacyMigration.accountIdPreserved,
      gitlabLegacyDefaultSitePersisted: legacyMigration.defaultSitePersisted,
      gitlabLegacySyntheticDefaultOrigin: legacyMigration.syntheticDefaultOrigin,
      gitlabReconnectOriginLocked: true,
      gitlabPatAndOAuthAccounts: true,
      gitlabPrivateRedirectRefused: true,
      gitlabMutationApprovalPreserved: true,
    };
  });
}
