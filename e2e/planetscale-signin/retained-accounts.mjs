import assert from "node:assert/strict";
import { Effect } from "effect";
import { Browser } from "../../.upstream/e2e/support/browser.ts";
import { tokenOnly, sorted, legacyOperations } from "./expectations.mjs";
import { hostedClient, serviceToken } from "./service.mjs";

import { verifyRetainedReconnect } from "./retained-reconnect.mjs";

const unknownPermissions = "Unknown: PlanetScale did not report this account's permissions.";
const readTool = "databases.listDatabases";
const writeTool = "databaseBranches.demoteBranch";

/**
 * Keep real API responses so this can assert approval refusals as well as successful requests.
 * `request` has the same shape as `client.request(session, method, path, body)`.
 */
export const verifyPlanetScaleRetainedAccounts = ({
  request,
  prefix,
  app,
  session,
  fixture,
  service,
  width,
  upgradeHost,
  unknown,
}) => {
  const appPath = `${prefix}/apps/${app.id}`;
  const savedAccountIds = [];
  const baselineAccountIds = new Set();
  const raw = (method, path, data) => request(method, path, data);
  const body = (method, path, data) =>
    raw(method, path, data).pipe(
      Effect.map((response) => {
        assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(response.body)}`);
        return response.body;
      }),
    );
  const toolCall = (tool, accountId, input = {}) =>
    raw("POST", `${appPath}/tools/call`, { tool, input: { accountId, input } });
  const readWith = (accountId, credential) =>
    Effect.gen(function* () {
      const response = yield* toolCall(readTool, accountId, { path: { organization: "acme" } });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.deepEqual(response.body, { operation: "list_databases", credential });
    });
  const apiCallCount = () => service.calls.filter((call) => call.phase === "api").length;
  const cleanupOne = (accountId) =>
    Effect.gen(function* () {
      const unlinked = yield* raw("DELETE", `${appPath}/accounts/user/planetscale/${accountId}`);
      assert.equal(unlinked.status, 200, `Unlink ${accountId}: ${JSON.stringify(unlinked.body)}`);
      const deleted = yield* raw("DELETE", `${prefix}/accounts/${accountId}`);
      assert.equal(deleted.status, 200, `Delete ${accountId}: ${JSON.stringify(deleted.body)}`);
    });
  const cleanup = Effect.suspend(() =>
    Effect.gen(function* () {
      const linksResponse = yield* raw("GET", `${appPath}/accounts/user`);
      assert.equal(linksResponse.status, 200, JSON.stringify(linksResponse.body));
      const discoveredIds = linksResponse.body
        .filter(
          (link) => link.requirement === "planetscale" && !baselineAccountIds.has(link.account.id),
        )
        .map((link) => link.account.id);
      const accountIds = [...new Set([...savedAccountIds, ...discoveredIds])].reverse();
      const results = yield* Effect.forEach(
        accountIds,
        (accountId) => Effect.exit(cleanupOne(accountId)),
        { concurrency: 1 },
      );
      const failures = results.filter((result) => result._tag === "Failure");
      assert.equal(
        failures.length,
        0,
        `Failed to unlink and delete retained PlanetScale accounts: ${accountIds.join(", ")}`,
      );
    }),
  );

  return Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.login(session);

    // Re-deploy the actual published catalog snapshot through the app's public deploy route.
    yield* body("POST", `${appPath}/deploy`, {
      files: yield* Effect.promise(() => fixture.publishedFiles()),
    });
    const before = yield* body("GET", appPath);
    const beforeRequirement = before.requirements.accounts.planetscale;
    assert.ok(beforeRequirement, "The published app has the legacy PlanetScale requirement");
    assert.equal(before.requirements.accounts.planetscaleSignIn, undefined);
    const baselineLinks = yield* body("GET", `${appPath}/accounts/user`);
    for (const link of baselineLinks) baselineAccountIds.add(link.account.id);
    const beforeProvider = {
      provider: beforeRequirement.provider,
      definition: beforeRequirement.definition,
    };

    const tokenConnection = yield* body(
      "POST",
      `${appPath}/accounts/user/planetscale/connections`,
      {},
    );
    const token = yield* body("POST", `${prefix}/connections/${tokenConnection.id}/submit`, {
      method: "token",
      label: "Retained PlanetScale service token",
      fields: { token: serviceToken },
    });
    savedAccountIds.push(token.id);

    const linksBeforeOAuth = yield* body("GET", `${appPath}/accounts/user`);
    const oauthConnection = yield* body(
      "POST",
      `${appPath}/accounts/user/planetscale/connections`,
      {},
    );
    const oauthStart = yield* body(
      "POST",
      `${prefix}/connections/${oauthConnection.id}/oauth/start`,
      {
        method: "oauth2",
        label: "Retained legacy PlanetScale OAuth",
      },
    );
    assert.equal(new URL(oauthStart.authorizationUrl).origin, service.origin);
    yield* browser.use("Authorize the retained PlanetScale OAuth account", async (page) => {
      await page.goto(oauthStart.authorizationUrl);
      await page
        .getByRole("heading", { name: "PlanetScale test authorization", exact: true })
        .waitFor();
      await page.getByRole("button", { name: "Authorize", exact: true }).click();
      const naming = page.getByRole("dialog", { name: "Name this account", exact: true });
      await naming.getByLabel("Account name", { exact: true }).fill("Retained legacy OAuth");
      await naming.getByRole("button", { name: "Save name", exact: true }).click();
      await page.getByRole("region", { name: "Your accounts", exact: true }).waitFor();
      await page.setViewportSize({ width, height: 844 });
    });
    const linksAfterOAuth = yield* body("GET", `${appPath}/accounts/user`);
    const previousIds = new Set(linksBeforeOAuth.map((link) => link.account.id));
    const addedOAuth = linksAfterOAuth.filter(
      (link) => link.requirement === "planetscale" && !previousIds.has(link.account.id),
    );
    assert.equal(addedOAuth.length, 1, "The legacy OAuth flow saves one linked account");
    const oauth = addedOAuth[0].account;
    savedAccountIds.push(oauth.id);
    assert.equal(oauth.method, "oauth2");

    const beforeLinks = yield* body("GET", `${appPath}/accounts/user`);
    const retainedBefore = beforeLinks
      .filter((link) => link.requirement === "planetscale")
      .map(({ account }) => ({ id: account.id, method: account.method }))
      .sort((left, right) => left.id.localeCompare(right.id));
    assert.deepEqual(
      retainedBefore,
      [
        { id: token.id, method: "token" },
        { id: oauth.id, method: "oauth2" },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    const beforeTools = yield* body("GET", `${appPath}/tools/index`);
    assert.ok(beforeTools.items.some((tool) => tool.name === readTool));
    yield* readWith(token.id, "token");
    yield* readWith(oauth.id, "oauth");

    yield* browser.checkpoint("PlanetScale published accounts before upgrade");
    yield* upgradeHost;
    yield* body("POST", `${appPath}/deploy`, {
      files: yield* Effect.promise(() => fixture.currentFiles()),
    });
    const after = yield* body("GET", appPath);
    const afterRequirement = after.requirements.accounts.planetscale;
    assert.deepEqual(
      afterRequirement,
      beforeRequirement,
      "The full legacy requirement and provider definition survive the upgrade",
    );
    assert.deepEqual(
      {
        provider: afterRequirement.provider,
        definition: afterRequirement.definition,
      },
      beforeProvider,
      "The legacy provider identity and definition stay unchanged",
    );
    assert.ok(after.requirements.accounts.planetscaleSignIn);

    const afterLinks = yield* body("GET", `${appPath}/accounts/user`);
    const retainedAfter = afterLinks
      .filter((link) => link.requirement === "planetscale")
      .map(({ account }) => ({ id: account.id, method: account.method }))
      .sort((left, right) => left.id.localeCompare(right.id));
    assert.deepEqual(retainedAfter, retainedBefore, "Both saved IDs and methods remain linked");

    const afterTools = yield* body("GET", `${appPath}/tools/index`);
    assert.ok(afterTools.items.some((tool) => tool.name === readTool));
    yield* readWith(token.id, "token");
    yield* readWith(oauth.id, "oauth");

    const permissions = yield* raw("POST", `${appPath}/tools/call`, {
      tool: "permissions",
      input: {},
    });
    assert.equal(permissions.status, 200, JSON.stringify(permissions.body));
    const legacyOAuth = permissions.body.find((row) => row.accountId === oauth.id);
    assert.equal(legacyOAuth.accountId, oauth.id);
    assert.equal(legacyOAuth.method, "legacy OAuth");
    if (unknown) assert.equal(legacyOAuth.permissions, unknownPermissions);
    else {
      const authorization = service.calls.find((call) => call.phase === "authorize");
      assert.equal(authorization.scope.split(" ").length, 28);
      const renewal = service.calls.findLast(
        (call) => call.phase === "token" && call.grant === "refresh_token",
      );
      assert.equal(renewal.reportedScopes.length, 27);
      assert.deepEqual(
        sorted(legacyOAuth.permissions),
        sorted(
          new Set([
            ...renewal.reportedScopes,
            "user:read_user",
            "organization:read_organization",
            "organization:write_organization",
          ]),
        ),
        "Refreshed fields and normalized scopes use the same committed snapshot",
      );
      assert.equal(legacyOAuth.permissions.includes("organization:write_comments"), false);
    }
    if (unknown) assert.equal(legacyOAuth.unavailableTools, null);
    else {
      const granted = new Set(legacyOAuth.permissions);
      const unavailableOAuth = legacyOperations
        .filter(
          (operation) =>
            operation.oauthScopes.length > 0 &&
            !operation.oauthScopes.some((scope) => granted.has(scope)),
        )
        .map((operation) => operation.name);
      assert.deepEqual(
        sorted(legacyOAuth.unavailableTools),
        sorted([...unavailableOAuth, ...tokenOnly]),
      );
      assert.ok(
        legacyOAuth.unavailableTools.includes("databaseBranches.demoteBranch"),
        "A known legacy grant must not imply an ungranted write is available",
      );
    }
    assert.ok(
      service.calls.some((call) => call.phase === "token" && call.grant === "refresh_token"),
      "The retained grant actually renewed",
    );
    assert.ok(
      afterTools.items.some((tool) => tool.name === readTool),
      "Legacy scope metadata does not remove the existing read tool",
    );

    for (const accountId of [token.id, oauth.id]) {
      const callsBeforeWrite = apiCallCount();
      const write = yield* toolCall(writeTool, accountId, {
        path: { organization: "acme", database: "app", branch: "main" },
      });
      assert.equal(write.status, 409, "Every PlanetScale mutation requires approval");
      assert.equal(write.body._tag, "ToolApprovalRequired");
      assert.equal(
        apiCallCount(),
        callsBeforeWrite,
        "An unapproved write never reaches PlanetScale",
      );
    }
    assert.ok(
      service.calls.some((call) => call.phase === "authorize" && call.client === hostedClient.id),
      "Legacy OAuth uses the supplied hosted client",
    );
    assert.equal(
      service.calls.some((call) => call.phase === "api" && call.credential === "none"),
      false,
    );
    assert.deepEqual(service.failures, []);

    const reconnectScopes = unknown
      ? undefined
      : yield* verifyRetainedReconnect({
          body,
          raw,
          prefix,
          appPath,
          oauth,
          retainedIds: savedAccountIds.slice().sort(),
          width,
        });
    if (!unknown) yield* readWith(oauth.id, "oauth");
    return {
      reconnectScopes,
      tokenId: token.id,
      tokenMethod: token.method,
      oauthId: oauth.id,
      oauthMethod: oauth.method,
      publishedRequirement: beforeRequirement,
      currentRequirement: afterRequirement,
      grantedPermissions: legacyOAuth.permissions,
      refreshes: service.calls.filter(
        (call) => call.phase === "token" && call.grant === "refresh_token",
      ).length,
    };
  }).pipe(Effect.ensuring(cleanup));
};
