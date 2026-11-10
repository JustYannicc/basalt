import assert from "node:assert/strict";
import { test } from "node:test";

const upstream = (path: string) => new URL(`../../.upstream/${path}`, import.meta.url).href;
const { firstPartyGrantedScopes, oauthScopeClosure } = await import(
  upstream("packages/sdk/src/contracts/oauth-scopes.ts")
);
const { missingOAuthScopes } = await import(
  upstream("packages/sdk/src/contracts/oauth-families.ts")
);
const { planetScaleOAuthClient: client } = await import(
  upstream("apps/hosted/server/src/implementation/planetscale-oauth.ts")
);

const requested: string[] = client.defaultScopes;
const allowed = new Set<string>(
  oauthScopeClosure(client.allowedScopes, client.server.scopeImplications),
);
/** What the callback stores, and whether its allowed check keeps the grant. */
const exchange = (names: readonly string[]) => {
  const reported: string[] = firstPartyGrantedScopes(
    client.server,
    client.allowedScopes,
    names.join(" "),
    requested,
  );
  const granted: string[] = oauthScopeClosure(reported, client.server.scopeImplications);
  return { reported, granted, kept: granted.every((scope) => allowed.has(scope)) };
};

// Names-only shape of a production PlanetScale token response, in its order.
const productionGrant = [
  "approve_deploy_requests",
  "create_databases",
  "delete_backups",
  "delete_databases",
  "delete_organization",
  "delete_members",
  "delete_production_branches",
  "manage_branch_topologies",
  "manage_production_branch_topologies",
  "manage_production_read_only_passwords",
  "read_audit_logs",
  "read_branches",
  "read_comments",
  "read_deploy_requests",
  "read_databases",
  "read_members",
  "read_organization",
  "read_workflows",
  "restore_production_branch_backups",
  "write_branches",
  "write_comments",
  "write_databases",
  "write_deploy_requests",
  "write_organization",
  "write_payment_method",
  "write_workflows",
  "delete_branches",
  "delete_production_branch_backups",
  "restore_backups",
  "manage_passwords",
  "manage_read_only_passwords",
  "read_backups",
  "deploy_deploy_requests",
  "manage_production_branch_passwords",
  "write_backups",
  "promote_branches",
  "write_members",
  "manage_sso",
  "read_payment_method",
  "read_invoices",
  "demote_branches",
  "write_branch",
  "manage_topology",
  "read_organizations",
  "read_user",
  "write_user",
];

test("PlanetScale's bare-name grant is kept as the prefixed access it stands for", () => {
  assert.equal(productionGrant.length, 46);
  const { reported, granted, kept } = exchange(productionGrant);
  assert.equal(kept, true);
  assert.deepEqual(missingOAuthScopes(client.server.issuer, requested, granted), []);
  // Each name stays one scope: requested ones keep their resource, others take the narrowest.
  assert.equal(reported.length, 46);
  for (const [bare, stored] of [
    ["read_branches", "organization:read_branches"],
    ["demote_branches", "database:demote_branches"],
    ["read_comments", "database:read_comments"],
    ["delete_organization", "organization:delete_organization"],
    ["write_branch", "branch:write_branch"],
    ["manage_topology", "branch:manage_topology"],
    ["read_user", "read_user"],
  ])
    assert.ok(reported.includes(stored), `${bare} -> ${stored}`);
  for (const widened of [
    "organization:read_comments",
    "organization:demote_branches",
    "database:read_branches",
    "branch:read_branches",
  ])
    assert.ok(!granted.includes(widened), `${widened} is not stored`);
  const bare = reported.filter((scope) => !scope.includes(":"));
  assert.deepEqual(bare.sort(), [
    "read_databases",
    "read_organization",
    "read_organizations",
    "read_user",
    "write_databases",
    "write_organization",
    "write_user",
  ]);
});

test("PlanetScale grants with an unpublished name are still refused", () => {
  for (const unknown of [
    "manage_everything",
    "organization:manage_everything",
    "branch:read_branches_all",
  ]) {
    const { reported, kept } = exchange([...productionGrant, unknown]);
    assert.equal(kept, false, unknown);
    assert.ok(reported.includes(unknown), `${unknown} stays as reported`);
  }
});

test("servers without grant prefixes keep reported names unchanged", () => {
  const { grantedScopePrefixes: _, ...server } = client.server;
  assert.deepEqual(
    firstPartyGrantedScopes(server, client.allowedScopes, "read_branches read_user", requested),
    ["read_branches", "read_user"],
  );
  // Without the prefixes, the production grant is refused as before the fix.
  const reported = firstPartyGrantedScopes(
    server,
    client.allowedScopes,
    productionGrant.join(" "),
    requested,
  );
  const granted: string[] = oauthScopeClosure(reported, server.scopeImplications);
  assert.equal(
    granted.filter((scope) => !allowed.has(scope)).length,
    39,
    "39 bare names exceed the envelope",
  );
});
