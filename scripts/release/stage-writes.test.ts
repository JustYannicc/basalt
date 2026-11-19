import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createdIdentities,
  ownIdentities,
  stageWriteVerdict,
  type StageScope,
} from "./stage-writes.ts";

const scope: StageScope = {
  stack: "basalt-rehearsal",
  stage: "test-rehearsal-2",
  label: "rehearsal-2",
  databases: ["basalt-preview-rehearsal-2"],
  owned: ["basalt-rehearsal-api-test-rehearsal-2-x1", "app-stage-1", "dns-stage-1", "hd-stage-1"],
};
const CF = "https://api.cloudflare.com/client/v4/accounts/acct";
const ZONE = "https://api.cloudflare.com/client/v4/zones/zone";
const PS = "https://api.planetscale.com/v1/organizations/org";
const STATE = "https://state-store.example";
const owned = (value: string) => scope.owned.includes(value);
const verdict = (method: string, url: string, body?: unknown) =>
  stageWriteVerdict(scope, owned, method, new URL(url), body).kind;

test("State store writes stay on the stage's own stack and stage", () => {
  const own = `${STATE}/state/stacks/basalt-rehearsal/stages/test-rehearsal-2`;
  assert.equal(verdict("PUT", `${own}/resources/Api`), "allow");
  assert.equal(verdict("PUT", `${own}/output`), "allow");
  assert.equal(
    verdict("PUT", `${STATE}/state/stacks/basalt/stages/production/resources/Api`),
    "refuse",
  );
  assert.equal(
    verdict(
      "DELETE",
      `${STATE}/state/stacks/basalt-rehearsal/stages/test-rehearsal-1/resources/Api`,
    ),
    "refuse",
  );
  // A destroy drops its own stage; without a stage the delete would drop every stage of the stack.
  assert.equal(
    verdict("DELETE", `${STATE}/state/stacks/basalt-rehearsal?stage=test-rehearsal-2`),
    "allow",
  );
  assert.equal(verdict("DELETE", `${STATE}/state/stacks/basalt-rehearsal`), "refuse");
  assert.equal(verdict("DELETE", `${STATE}/state/stacks/basalt?stage=test-rehearsal-2`), "refuse");
});

test("database-provider writes reach only the stage's own database", () => {
  const own = `${PS}/databases/basalt-preview-rehearsal-2`;
  assert.equal(verdict("POST", `${own}/branches/test-rehearsal-2-pool/roles`), "allow");
  assert.equal(verdict("PATCH", own), "allow");
  assert.equal(verdict("PATCH", `${PS}/databases/basalt/branches/main/changes`), "refuse");
  assert.equal(verdict("POST", `${PS}/databases`, { name: "basalt-preview-rehearsal-2" }), "allow");
  assert.equal(verdict("POST", `${PS}/databases`, { name: "basalt" }), "refuse");
});

test("a Worker is the stage's by its State name, or proven live by Cloudflare", () => {
  assert.equal(
    verdict("PUT", `${CF}/workers/scripts/basalt-rehearsal-api-test-rehearsal-2-x1`),
    "allow",
  );
  const unknown = stageWriteVerdict(
    scope,
    owned,
    "PUT",
    new URL(`${CF}/workers/scripts/basalt-production-api`),
    undefined,
  );
  assert.deepEqual(unknown, { kind: "prove", family: "Worker", name: "basalt-production-api" });
  assert.equal(verdict("PUT", `${CF}/workflows/some-workflow`), "prove");
});

test("resources addressed by id must be the stage's; a create is the stage's by construction", () => {
  assert.equal(verdict("PATCH", `${CF}/containers/applications/app-stage-1`), "allow");
  assert.equal(verdict("POST", `${CF}/containers/applications/app-stage-1/rollouts`), "allow");
  assert.equal(verdict("PATCH", `${CF}/containers/applications/app-production`), "refuse");
  assert.equal(verdict("PUT", `${CF}/hyperdrive/configs/hd-production`), "refuse");
  assert.deepEqual(
    stageWriteVerdict(scope, owned, "POST", new URL(`${CF}/hyperdrive/configs`), { name: "x" }),
    { kind: "allow", creates: true },
  );
  assert.equal(
    verdict("POST", `${CF}/containers/registries/registry.example/credentials`),
    "allow",
  );
});

test("a hostname a stage attaches must carry the stage's label, on a Worker the stage owns", () => {
  const domain = (hostname: string, service: string) =>
    verdict("PUT", `${CF}/workers/domains`, { hostname, service });
  assert.equal(
    domain("app.rehearsal-2.example.dev", "basalt-rehearsal-api-test-rehearsal-2-x1"),
    "allow",
  );
  assert.equal(domain("app.example.dev", "basalt-rehearsal-api-test-rehearsal-2-x1"), "refuse");
  assert.equal(
    domain("app.rehearsal-20.example.dev", "basalt-rehearsal-api-test-rehearsal-2-x1"),
    "refuse",
  );
  assert.equal(domain("app.rehearsal-2.example.dev", "basalt-production-api"), "refuse");
  assert.equal(
    verdict("POST", `${ZONE}/dns_records`, { name: "app.rehearsal-2.example.dev" }),
    "allow",
  );
  assert.equal(verdict("POST", `${ZONE}/dns_records`, { name: "app.example.dev" }), "refuse");
  assert.equal(verdict("PATCH", `${ZONE}/dns_records/dns-stage-1`), "allow");
  assert.equal(verdict("DELETE", `${ZONE}/dns_records/dns-production`), "refuse");
  assert.equal(
    verdict("POST", `${ZONE}/workers/routes`, {
      pattern: "app.rehearsal-2.example.dev/*",
      script: "basalt-rehearsal-api-test-rehearsal-2-x1",
    }),
    "allow",
  );
});

test("the shared Secrets Store and any write the module cannot place are refused", () => {
  assert.equal(verdict("POST", `${CF}/secrets_store/stores/app-stage-1/secrets`), "refuse");
  assert.equal(verdict("POST", `${CF}/unknown-api`), "refuse");
  assert.equal(verdict("PATCH", `${ZONE}/settings/ssl`), "refuse");
  // Hosts other than the providers' APIs and the State store are not production's resources.
  assert.equal(verdict("POST", "https://emulator.example/billing/seed"), "allow");
});

test("own identities come from each row's own attributes, never from shared references", () => {
  const rows = [
    {
      resourceType: "Cloudflare.Container",
      attr: { applicationId: "app-1", name: "app-name", accountId: "acct", namespaceId: "ns-1" },
    },
    { resourceType: "Cloudflare.Worker", attr: { workerName: "worker-1", zoneId: "zone" } },
    // An interrupted update keeps the last settled generation under `old`.
    {
      resourceType: "Cloudflare.Hyperdrive",
      attr: { hyperdriveId: "hd-new" },
      old: { attr: { hyperdriveId: "hd-old" } },
    },
    // The account's one Secrets Store is shared with production even when a stage adopts it.
    { resourceType: "Cloudflare.SecretsStore.Store", attr: { id: "store", storeId: "store" } },
    { resourceType: "Cloudflare.Worker", attr: { url: "https://x.example", tags: ["a"] } },
  ];
  assert.deepEqual(ownIdentities(rows), [
    "app-1",
    "app-name",
    "hd-new",
    "hd-old",
    "ns-1",
    "worker-1",
  ]);
  assert.deepEqual(
    createdIdentities({ result: { id: "new-id", created_on: "t" } }, { name: "new-name" }),
    ["new-id", "new-name"],
  );
});
