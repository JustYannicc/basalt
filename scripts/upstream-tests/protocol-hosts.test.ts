import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted, Schema } from "effect";
import {
  HostInvocation,
  CredentialHost,
} from "../../.upstream/packages/apps/src/contracts/host.ts";
import {
  HostInvocation as PreviousInvocation,
  CredentialHost as PreviousCredentialHost,
} from "../../.upstream/packages/apps/src/contracts/protocols/39.ts";
import {
  HostInvocation as FrozenInvocation,
  CredentialHost as FrozenCredentialHost,
} from "../../.upstream/packages/apps/src/contracts/protocols/40.ts";
import { AccountUnavailable } from "../../.upstream/packages/apps/src/contracts/account-unavailable.ts";
import { WorkflowFailure } from "../../.upstream/packages/apps/src/contracts/workflows.ts";
import {
  appProtocol,
  supportedProtocols,
} from "../../.upstream/packages/sdk/src/implementation/app-protocols.ts";
import {
  bundleAccounts,
  retainedCredentialHosts,
} from "../../.upstream/packages/sdk/src/implementation/app-protocol-accounts.ts";
import { credentialFetch } from "../../.upstream/packages/sdk/src/implementation/credential-handles.ts";
import * as fixture from "./protocol-hosts-fixture.ts";

test("retained account metadata preserves absent scopes, cardinality and the original accounts", () => {
  const input = fixture.accounts();
  const before = structuredClone(input);
  const output = retainedCredentialHosts(input);
  assert.deepEqual(output.app.empty, []);
  assert.deepEqual(output.user?.empty, []);
  assert.equal(Object.hasOwn(retainedCredentialHosts({ app: input.app }), "user"), false);
  assert.deepEqual(input, before);
  const selected = output.app.one;
  assert.ok(selected && "provider" in selected);
  assert.deepEqual(selected.provider.hosts, ["strict.example.test"]);
  assert.deepEqual(selected.oauthScopes, ["read"]);
  assert.deepEqual(selected.fields, fixture.account().fields);
  assert.equal(selected.mcpEndpoint, fixture.account().mcpEndpoint);
  assert.equal(selected.generation, 7);
  const onlyUnderscore = retainedCredentialHosts({
    app: { one: fixture.account(["svc_one.example.test"]) },
  });
  const empty = onlyUnderscore.app.one;
  assert.ok(empty && "provider" in empty);
  assert.deepEqual(empty.provider.hosts, []);
  const strict = fixture.account(["strict.example.test"]);
  assert.equal(retainedCredentialHosts({ app: { strict } }).app.strict, strict);
  const { hosts: _hosts, ...provider } = strict.provider;
  const noHosts = { ...strict, provider };
  assert.equal(retainedCredentialHosts({ app: { noHosts } }).app.noHosts, noHosts);
});

test("p39 and p40 retain their original credential-host grammar", () => {
  for (const schema of [PreviousCredentialHost, FrozenCredentialHost]) {
    for (const value of [
      "example.test",
      "*.example.test",
      "service.example.test:8443",
      "localhost:1234",
    ])
      assert.equal(Schema.is(schema)(value), true, value);
    for (const value of [
      "svc_one.example.test",
      "*.dev_net.test",
      "_svc",
      "https://example.test",
      "example.test/path",
      "EXAMPLE.test",
      `${"a".repeat(64)}.test`,
    ])
      assert.equal(Schema.is(schema)(value), false, value);
  }
});

test("protocol42 keeps underscore metadata while still sealing credentials", async () => {
  const adapter = await Effect.runPromise(appProtocol(42));
  const selected = await Effect.runPromise(
    bundleAccounts(
      adapter,
      fixture.app,
      fixture.key,
      fixture.accounts(),
    ),
  );
  const account = selected.app.one;
  assert.ok(account && "fields" in account && account.fields);
  assert.deepEqual(account.provider.hosts, fixture.hosts);
  assert.match(String(account.fields.token), /^exsec_/);
  const encoded = adapter.invocation(fixture.invocation(selected));
  assert.doesNotThrow(() => Schema.decodeUnknownSync(HostInvocation)(JSON.parse(encoded)));
  for (const host of ["svc_one.example.test", "*.dev_net.test", "_svc"])
    assert.equal(Schema.is(CredentialHost)(host), true);
});

for (const version of supportedProtocols.filter((version) => version < 42)) {
  test(`protocol ${version} composes strict hosts with its invocation and Workflow account rules`, async () => {
    const adapter = await Effect.runPromise(appProtocol(version));
    const boundary = () => bundleAccounts(adapter, fixture.app, fixture.key, fixture.accounts());
    const selected = await Effect.runPromise(boundary());
    const encoded = adapter.invocation(fixture.invocation(selected));
    assert.equal(encoded.includes("svc_one"), false);
    assert.equal(encoded.includes("synthetic-protocol-hosts-token"), version < 7);
    assert.equal(encoded.includes('"oauthScopes"'), version >= 39);
    assert.equal(encoded.includes('"mcpEndpoint"'), version >= 36);
    assert.equal(encoded.includes('"caller"'), version >= 14);
    if (version === 39)
      assert.doesNotThrow(() => Schema.decodeUnknownSync(PreviousInvocation)(JSON.parse(encoded)));
    if (version === 40)
      assert.doesNotThrow(() => Schema.decodeUnknownSync(FrozenInvocation)(JSON.parse(encoded)));
    let generation = 0;
    const execution = adapter.workflow(
      fixture.workflow(() =>
        bundleAccounts(
          adapter,
          fixture.app,
          fixture.key,
          fixture.accounts({ ...fixture.account(), generation: ++generation }),
        ).pipe(
          Effect.mapError(() => new WorkflowFailure({ reason: "credentials", retryable: false })),
          Effect.map(fixture.context),
        ),
      ),
    );
    for (let step = 1; step <= 2; step++) {
      const context = await Effect.runPromise(execution.resolve());
      const accounts = Redacted.value(context.accounts);
      const text = JSON.stringify(accounts);
      assert.equal(text.includes("svc_one"), false);
      assert.equal(text.includes(`"generation":${step}`), true);
      assert.equal(text.includes('"oauthScopes"'), version >= 39);
      assert.equal(text.includes('"mcpEndpoint"'), version >= 36);
    }
  });
}

test("filtering provider metadata after sealing retains the original outbound host and app authority", async () => {
  const adapter = await Effect.runPromise(appProtocol(40));
  const input = fixture.accounts();
  const sealed = await Effect.runPromise(bundleAccounts(adapter, fixture.app, fixture.key, input));
  const selected = sealed.app.one;
  assert.ok(selected && "fields" in selected && selected.fields);
  const handle = selected.fields.token;
  assert.equal(typeof handle, "string");
  assert.match(String(handle), /^exsec_/);
  assert.deepEqual(selected.provider.hosts, ["strict.example.test"]);
  const delivered: { url: string; token: string | null }[] = [];
  const key = await Effect.runPromise(fixture.key);
  const outbound = (app = fixture.app) => ({
    app,
    key,
    egress: { refusePrivateAddresses: false, selfOrigin: undefined },
    send: async (request: Request) => {
      delivered.push({ url: request.url, token: request.headers.get("authorization") });
      return new Response("received");
    },
  });
  const request = (host: string) =>
    new Request(`https://${host}/fixture`, { headers: { authorization: String(handle) } });
  assert.equal(
    (await credentialFetch(request("svc_one.example.test:8443"), outbound())).status,
    200,
  );
  assert.deepEqual(delivered, [
    { url: "https://svc_one.example.test:8443/fixture", token: "synthetic-protocol-hosts-token" },
  ]);
  for (const target of [
    "sibling.example.test:8443",
    "deeper.svc_one.example.test:8443",
    "svc_one.example.test:8444",
  ]) {
    const refused = await credentialFetch(request(target), outbound());
    assert.notEqual(refused.status, 200, target);
  }
  assert.notEqual(
    (await credentialFetch(request("svc_one.example.test:8443"), outbound("sibling-app"))).status,
    200,
  );
  assert.equal(delivered.length, 1);
  assert.deepEqual(input.app.one, fixture.account());
});

test("unavailable bindings keep their ID and failure without receiving credential fields", async () => {
  const { fields: _fields, ...metadata } = fixture.account();
  const unavailable = {
    ...metadata,
    unavailable: new AccountUnavailable({ accountId: metadata.id, failure: { kind: "reconnect" } }),
  };
  const adapter = await Effect.runPromise(appProtocol(40));
  const selected = await Effect.runPromise(
    bundleAccounts(adapter, fixture.app, fixture.key, fixture.accounts(unavailable)),
  );
  const encoded = adapter.invocation(fixture.invocation(selected));
  const decoded = Schema.decodeUnknownSync(FrozenInvocation)(JSON.parse(encoded));
  const binding = decoded.accounts.app.one;
  assert.ok(binding && "provider" in binding);
  assert.equal(binding.id, unavailable.id);
  assert.deepEqual(binding.unavailable, unavailable.unavailable);
  assert.equal(Object.hasOwn(binding, "fields"), false);
  assert.deepEqual(binding.provider.hosts, ["strict.example.test"]);
});

test("legacy managed-account refusal happens before conversion or credential disclosure", async () => {
  for (const version of supportedProtocols.filter((version) => version < 7)) {
    const adapter = await Effect.runPromise(appProtocol(version));
    let converted = false;
    const result = await Effect.runPromise(
      bundleAccounts(
        {
          ...adapter,
          accounts: (accounts) => {
            converted = true;
            return accounts;
          },
        },
        fixture.app,
        fixture.key,
        fixture.accounts({ ...fixture.account(), managed: true }),
      ).pipe(Effect.flip),
    );
    assert.equal(result.reason, "managed");
    assert.equal(converted, false);
  }
});
