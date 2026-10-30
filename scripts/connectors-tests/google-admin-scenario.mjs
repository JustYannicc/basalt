import assert from "node:assert/strict";
import { Effect } from "effect";
import { providerProbeFiles } from "./google-admin-catalog.mjs";
import { deploymentPayload } from "./provider-evidence.mjs";

/** Exercise shared-client selection and refusal through the running hosted server. */
export const proveGoogleAdminOAuth = ({
  actors,
  admin,
  adminFiles,
  adminScopes,
  appsManifest,
  callbackUrl,
  checked,
  clientId,
  googleClient,
  googleMetadata,
  normal,
  orgPath,
  productName,
  record,
  request,
  setStage,
  state,
}) =>
  Effect.gen(function* () {
    const deploy = (name, files) =>
      Effect.gen(function* () {
        const app = checked(
          yield* request(actors.owner, "POST", orgPath + "/apps/deploy", {
            name,
            files: files.some((file) => file.path === "package.json")
              ? files
              : [...files, appsManifest],
          }),
          200,
          "Deploy " + name,
        );
        assert.ok(app.id && app.slug, "The deployed app needs an id and slug");
        const appPath = orgPath + "/apps/" + app.id;
        const access = checked(
          yield* request(actors.owner, "GET", appPath + "/access"),
          200,
          "Read " + name + " audience",
        );
        checked(
          yield* request(actors.owner, "PATCH", appPath + "/access", {
            revision: access.revision,
            audience: { kind: "everyone" },
          }),
          200,
          "Share " + name + " with the synthetic organization",
        );
        state.deployments.push({
          name,
          appId: app.id,
          slug: app.slug,
          audience: "everyone in the synthetic organization",
          payload: deploymentPayload(files),
        });
        return { app, path: appPath };
      });

    const prepareSignIn = (actor, deployed, accountKey, label) =>
      Effect.gen(function* () {
        const requirement = deployed.app.requirements?.accounts?.[accountKey];
        assert.ok(requirement, "The app is missing account requirement " + accountKey);
        assert.equal(typeof requirement.provider, "string");
        const connection = checked(
          yield* request(
            actor,
            "POST",
            deployed.path + "/accounts/user/" + accountKey + "/connections",
            { destination: { kind: "personal" } },
          ),
          200,
          "Create " + label + " personal OAuth connection",
        );
        const setup = checked(
          yield* request(
            actor,
            "GET",
            orgPath +
              "/providers/" +
              encodeURIComponent(requirement.provider) +
              "/oauth/oauth/setup",
          ),
          200,
          "Read " + label + " OAuth setup",
        );
        const started = yield* request(
          actor,
          "POST",
          orgPath + "/connections/" + connection.id + "/oauth/start",
          { method: "oauth", label },
        );
        return { setup, started };
      });

    setStage("deploy-official-google-admin-app");
    const officialAdmin = yield* deploy(
      "Google Admin official catalog OAuth proof",
      adminFiles,
    );
    const adminSignIns = [];
    for (const [index, actor] of [actors.member, actors.admin].entries()) {
      const label = "Synthetic Google Admin user " + (index + 1);
      const result = yield* prepareSignIn(
        actor,
        officialAdmin,
        "googleAdmin",
        label,
      );
      assert.equal(result.setup.mode, "automatic");
      assert.deepEqual(result.setup.firstParty, {
        label: productName + " for Google",
      });
      assert.deepEqual(result.setup.scopes, admin.oauth.scopes);
      assert.equal(
        result.setup.tokenEndpointAuthMethod,
        googleClient.tokenEndpointAuthMethod,
      );
      assert.equal(result.started.status, 200);
      const url = new URL(result.started.body.authorizationUrl);
      assert.equal(url.origin + url.pathname, googleMetadata.authorization_endpoint);
      assert.equal(url.searchParams.get("client_id"), clientId);
      assert.deepEqual(
        new Set((url.searchParams.get("scope") ?? "").split(" ")),
        new Set(admin.oauth.scopes),
      );
      assert.equal(url.searchParams.get("access_type"), "offline");
      assert.equal(url.searchParams.get("prompt"), "consent");
      assert.equal(result.started.body.redirectUri, callbackUrl);
      assert.equal(url.searchParams.get("redirect_uri"), callbackUrl);
      adminSignIns.push({
        mode: result.setup.mode,
        firstParty: result.setup.firstParty.label,
        tokenEndpointAuthMethod: result.setup.tokenEndpointAuthMethod,
        scopeCount: result.setup.scopes.length,
        authorizationEndpoint: url.origin + url.pathname,
        clientIdMatches: url.searchParams.get("client_id") === clientId,
      });
    }
    assert.ok(
      adminSignIns.every((signIn) => signIn.clientIdMatches),
      "Separate users must receive the same operator-owned Google client",
    );
    record(
      "Two synthetic users received the shared client and all 21 official Google Admin scopes through the real server",
    );

    setStage("deploy-normal-google-scope-probe");
    const normalProbe = yield* deploy(
      "Google normal scope probe",
      providerProbeFiles(normal, "google"),
    );
    const normalResult = yield* prepareSignIn(
      actors.member,
      normalProbe,
      "google",
      "Synthetic normal Google user",
    );
    assert.equal(normalResult.setup.mode, "automatic");
    assert.deepEqual(normalResult.setup.firstParty, {
      label: productName + " for Google",
    });
    assert.deepEqual(normalResult.setup.scopes, normal.oauth.scopes);
    assert.equal(
      normalResult.setup.scopes.some((scope) => adminScopes.includes(scope)),
      false,
    );
    assert.equal(normalResult.started.status, 200);
    const normalUrl = new URL(normalResult.started.body.authorizationUrl);
    assert.equal(
      normalUrl.origin + normalUrl.pathname,
      googleMetadata.authorization_endpoint,
    );
    assert.deepEqual(
      new Set((normalUrl.searchParams.get("scope") ?? "").split(" ")),
      new Set(normal.oauth.scopes),
    );
    assert.equal(normalResult.started.body.redirectUri, callbackUrl);
    assert.equal(normalUrl.searchParams.get("redirect_uri"), callbackUrl);
    assert.equal(
      (normalUrl.searchParams.get("scope") ?? "")
        .split(" ")
        .some((scope) => adminScopes.includes(scope)),
      false,
    );
    record(
      "The official Google scope declaration received a normal grant with no Admin scopes",
    );

    setStage("refuse-google-admin-endpoint-and-scope-mismatches");
    const endpointMismatch = {
      name: "Google Admin",
      hosts: admin.hosts,
      oauth: {
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/authorize",
        tokenUrl: googleMetadata.token_endpoint,
        tokenEndpointAuthMethod: googleClient.tokenEndpointAuthMethod,
        scopes: admin.oauth.scopes,
        authorizationParams: admin.oauth.authorizationParams,
      },
    };
    const scopeMismatch = {
      name: "Google Admin",
      hosts: admin.hosts,
      oauth: {
        authorizationUrl: googleMetadata.authorization_endpoint,
        tokenUrl: googleMetadata.token_endpoint,
        tokenEndpointAuthMethod: googleClient.tokenEndpointAuthMethod,
        scopes: [
          ...admin.oauth.scopes,
          "https://www.googleapis.com/auth/cloud-platform",
        ],
        authorizationParams: admin.oauth.authorizationParams,
      },
    };
    for (const [label, definition] of [
      ["endpoint mismatch", endpointMismatch],
      ["scope mismatch", scopeMismatch],
    ]) {
      const probe = yield* deploy(
        "Google Admin " + label + " probe",
        providerProbeFiles(definition, "googleAdmin"),
      );
      const result = yield* prepareSignIn(
        actors.owner,
        probe,
        "googleAdmin",
        "Synthetic Google Admin " + label,
      );
      assert.equal(result.setup.mode, "client-required");
      assert.equal(result.setup.firstParty, undefined);
      assert.notEqual(
        result.started.body?._tag,
        undefined,
        "A mismatched Google Admin provider must not receive the shared client",
      );
      assert.equal(result.started.body?._tag, "OAuthClientUnavailable");
    }
    record(
      "Same-name Google Admin providers with a different authorization endpoint or unapproved scope were refused the shared client",
    );

    return {
      sharedAdminSignIns: adminSignIns,
      normalGoogle: {
        mode: normalResult.setup.mode,
        scopeCount: normalResult.setup.scopes.length,
        adminScopesPresent: false,
        authorizationEndpoint: normalUrl.origin + normalUrl.pathname,
      },
      mismatchOutcomes: ["client-required", "client-required"],
    };
  });
