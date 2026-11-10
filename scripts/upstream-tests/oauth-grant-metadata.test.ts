import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted, Schema } from "effect";
import {
  appProtocol,
  supportedProtocols,
} from "../../.upstream/packages/sdk/src/implementation/app-protocols.ts";
import type { WorkflowExecution } from "../../.upstream/packages/apps/src/contracts/workflows.ts";
import { HostInvocation } from "../../.upstream/packages/apps/src/contracts/host.ts";
import { oauthScopesProtocol } from "../../.upstream/packages/apps/src/contracts/protocol-version.ts";

const account = {
  id: "acc_metadata_fixture",
  provider: { name: "Metadata fixture", auth: {} },
  method: "oauth",
  generation: 7,
  mcpEndpoint: "https://mcp.example.test/server",
  oauthScopes: ["read", "write"],
  fields: { access_token: "exsec2.fixture", scope: "exsec2.scope" },
};
const input = Schema.decodeUnknownSync(HostInvocation)({
  command: { operation: "account-check", requirement: "service" },
  accounts: { app: { one: account, many: [account] }, user: { one: account, many: [account] } },
});

test("retained protocols omit OAuth metadata while protocol 36 keeps its MCP endpoint", async () => {
  for (const version of [35, 36]) {
    const adapter = await Effect.runPromise(appProtocol(version));
    const encoded = adapter.invocation(input);
    assert.equal(encoded.includes('"oauthScopes"'), false);
    const decoded = JSON.parse(encoded);
    assert.equal(decoded.accounts.app.one.fields.scope, "exsec2.scope");
    assert.equal(decoded.accounts.user.many[0].generation, 7);
    assert.equal(
      decoded.accounts.app.one.mcpEndpoint,
      version === 36 ? account.mcpEndpoint : undefined,
    );
  }
});

test("the metadata protocol keeps grant metadata and MCP endpoints without changing credential handles", async () => {
  const adapter = await Effect.runPromise(appProtocol(oauthScopesProtocol));
  const decoded = JSON.parse(adapter.invocation(input));
  assert.deepEqual(decoded.accounts.app.one.oauthScopes, ["read", "write"]);
  assert.equal(decoded.accounts.app.one.mcpEndpoint, account.mcpEndpoint);
  assert.equal(decoded.accounts.app.one.fields.access_token, "exsec2.fixture");
  assert.deepEqual(input.accounts.app.one, account);
});

test("workflow steps strip metadata only for retained consumers", async () => {
  const { WorkflowRunId } =
    await import("../../.upstream/packages/apps/src/contracts/workflows.ts");
  const execution: WorkflowExecution = {
    runId: WorkflowRunId.make("metadata-fixture"),
    driver: {
      do: (_name, _options, run) => run(),
      sleep: () => Effect.void,
      sleepUntil: () => Effect.void,
    },
    resolve: () => Effect.succeed({ accounts: Redacted.make(input.accounts) }),
    invoke: () => Effect.succeed(null),
  };
  for (const version of [35, 36, oauthScopesProtocol]) {
    const adapter = await Effect.runPromise(appProtocol(version));
    const context = await Effect.runPromise(adapter.workflow(execution).resolve());
    assert.equal(
      JSON.stringify(Redacted.value(context.accounts)).includes('"oauthScopes"'),
      version === oauthScopesProtocol,
    );
  }
});

test("managed credentials stay sealed while grant metadata remains readable", async () => {
  const { credentialKey, sealAccounts } =
    await import("../../.upstream/packages/sdk/src/implementation/credential-handles.ts");
  const { HostAccounts } = await import("../../.upstream/packages/apps/src/contracts/host.ts");
  const accounts = Schema.decodeUnknownSync(HostAccounts)({
    app: {
      service: {
        ...account,
        managed: true,
        fields: { access_token: "synthetic-token", scope: "read write" },
      },
    },
  });
  const sealed = await Effect.runPromise(
    sealAccounts(accounts, { app: "metadata-fixture", key: credentialKey("42".repeat(32)) }),
  );
  const selected = sealed.app.service;
  assert.ok(selected && "id" in selected);
  assert.deepEqual(selected.oauthScopes, ["read", "write"]);
  assert.ok(selected.fields !== undefined);
  for (const value of Object.values(selected.fields)) assert.match(String(value), /^exsec2_/);
  assert.equal(JSON.stringify(sealed).includes("synthetic-token"), false);
});

test("invocation accounts use the supplied grant snapshot, never the credential scope field", async () => {
  const { invocationAccount } =
    await import("../../.upstream/packages/sdk/src/implementation/provider.ts");
  const { AccountId } = await import("../../.upstream/packages/apps/src/contracts/schema.ts");
  const { httpsOnlyUrlPolicy } = await import("../../.upstream/packages/utils/src/url-policy.ts");
  const stored = {
    id: AccountId.make("acc_metadata_fixture"),
    method: "oauth",
    allowedHosts: null,
    site: null,
  };
  const definition = { name: "Metadata fixture", auth: {} };
  const fields = Redacted.make({ scope: "invented-wide-scope", access_token: "synthetic-token" });
  const recorded = ["read"];
  const known = invocationAccount(
    stored,
    definition,
    { fields, firstParty: undefined, oauthScopes: recorded, generation: 9 },
    new Map(),
    httpsOnlyUrlPolicy,
  );
  recorded.push("mutated-after-binding");
  assert.deepEqual(known.oauthScopes, ["read"]);
  assert.equal(known.generation, 9);
  const unknown = invocationAccount(
    stored,
    definition,
    { fields, firstParty: undefined, generation: 10 },
    new Map(),
    httpsOnlyUrlPolicy,
  );
  assert.equal(Object.hasOwn(unknown, "oauthScopes"), false);
});

test("every retained protocol omits OAuth metadata before its own account reshaping", async () => {
  for (const version of supportedProtocols.filter((version) => version < oauthScopesProtocol)) {
    const adapter = await Effect.runPromise(appProtocol(version));
    assert.equal(adapter.invocation(input).includes('"oauthScopes"'), false, `protocol ${version}`);
  }
});
