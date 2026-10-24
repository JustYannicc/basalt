import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zendeskAddition } from "../../src/catalog/zendesk/source.ts";
import { appsManifest } from "../../.upstream/e2e/support/apps-release.ts";

export const proveZendeskOAuthStart = ({
  Effect,
  request,
  checked,
  actors,
  directory,
  prefix,
  callback,
  candidateSha,
  upstreamPin,
  carriedPatches,
  step,
}) => Effect.gen(function* () {
  const record = (stage, fields) => appendFileSync(join(directory, "zendesk-proof.jsonl"),
    `${JSON.stringify({ candidateSha, upstreamPin, stage, ...fields })}\n`, { mode: 0o600 });
  const zendeskSource = zendeskAddition("example");
  const zendeskFiles = zendeskSource.source.files.filter((file) => file.path !== "package.json");
  const payload = { name: "Zendesk connector native OAuth proof", files: [...zendeskFiles, appsManifest] };
  const files = payload.files.map((file) => ({
    path: file.path,
    sha256: createHash("sha256").update(file.content).digest("hex"),
  }));
  const payloadSha256 = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  yield* Effect.promise(() => writeFile(join(directory, "zendesk-deployment.json"), `${JSON.stringify({
    candidateSha,
    upstreamPin,
    carriedPatches,
    tenantSubdomain: "example",
    payloadSha256,
    files,
    providerConsentCompleted: false,
  }, null, 2)}\n`, { mode: 0o600 }));
  const app = checked(yield* request(actors.owner, "POST", `${prefix}/apps/deploy`, payload),
    200, "Deploy tenant-bound Zendesk source");
  const path = `${prefix}/apps/${app.id}`;
  const access = checked(yield* request(actors.owner, "GET", `${path}/access`), 200, "Read Zendesk app audience");
  checked(yield* request(actors.owner, "PATCH", `${path}/access`, {
    revision: access.revision, audience: { kind: "everyone" },
  }), 200, "Share Zendesk app within organization");

  const users = [actors.member, actors.admin];
  const connections = [];
  for (const [index, actor] of users.entries()) {
    const connection = checked(yield* request(actor, "POST", `${path}/accounts/user/zendesk/connections`, {
      destination: { kind: "personal" },
    }), 200, "Create a personal Zendesk OAuth connection");
    connections.push(connection.id);
    const started = checked(yield* request(actor, "POST", `${prefix}/connections/${connection.id}/oauth/start`, {
      method: "oauth", label: `Synthetic Zendesk ${index + 1}`,
    }), 200, "Start Zendesk OAuth through the hosted runtime");
    const url = new URL(started.authorizationUrl);
    const scopes = (url.searchParams.get("scope") ?? "").split(" ").filter(Boolean).sort();
    record("authorization-start", {
      actor: index + 1,
      authorizationOrigin: url.origin,
      authorizationPath: url.pathname,
      clientId: url.searchParams.get("client_id"),
      redirectUri: started.redirectUri,
      callbackParameter: url.searchParams.get("redirect_uri"),
      responseType: url.searchParams.get("response_type"),
      scopes,
      pkceMethod: url.searchParams.get("code_challenge_method"),
      pkceChallengePresent: Boolean(url.searchParams.get("code_challenge")),
      clientSecretInUrl: url.searchParams.has("client_secret"),
    });
    assert.equal(started.redirectUri, callback, "Zendesk uses the registered callback");
    assert.equal(url.origin, "https://example.zendesk.com");
    assert.equal(url.pathname, "/oauth/authorizations/new");
    assert.equal(url.searchParams.get("client_id"), "zendesk-fixture-client");
    assert.equal(url.searchParams.get("redirect_uri"), callback);
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(url.searchParams.get("code_challenge"), "Zendesk OAuth uses a PKCE challenge");
    assert.deepEqual(new Set(scopes), new Set(["tickets:read", "tickets:write", "users:read"]));
    assert.equal(url.searchParams.has("client_secret"), false, "Zendesk client secret stays off the authorization URL");
  }
  for (const [index, actor] of users.entries()) {
    const peerStart = yield* request(actor, "POST", `${prefix}/connections/${connections[1 - index]}/oauth/start`, {
      method: "oauth", label: "Peer connection attempt",
    });
    record("peer-connection-denied", { actor: index + 1, status: peerStart.status });
    assert.ok(peerStart.status === 403 || peerStart.status === 404,
      "Zendesk peer cannot start another user's connection");
  }
  step("public-zendesk-oauth-start-and-peer-denials-passed");
  return { checks: 29 };
});
