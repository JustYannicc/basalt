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
  domain: "example.dev",
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

test("a stage's route can name only its own hosts and its own Worker, never a production host", () => {
  const route = (pattern: string, script = "basalt-rehearsal-api-test-rehearsal-2-x1") =>
    verdict("POST", `${ZONE}/workers/routes`, { pattern, script });
  // The stage's own Router host, as a disposable stage's Router declares it (routerRoutes).
  assert.equal(route("app.rehearsal-2.example.dev/*"), "allow");
  for (const hostile of [
    "app.example.dev/*",
    "*.example.dev/*",
    "*/*",
    "*",
    "/*",
    "*rehearsal-2.example.dev/*",
    "example.dev/*",
    "app.rehearsal-2.example.dev.evil.dev/*",
    "app.rehearsal-20.example.dev/*",
  ])
    assert.equal(route(hostile), "refuse", hostile);
  // The stage's host, but a Worker the stage does not own.
  assert.equal(route("app.rehearsal-2.example.dev/*", "basalt-router-production-x"), "refuse");
  assert.equal(
    verdict("POST", `${ZONE}/workers/routes`, { pattern: "app.rehearsal-2.example.dev/*" }),
    "refuse",
  );
});

test("the shared Secrets Store and any write the module cannot place are refused", () => {
  assert.equal(verdict("POST", `${CF}/secrets_store/stores/app-stage-1/secrets`), "refuse");
  assert.equal(verdict("POST", `${CF}/unknown-api`), "refuse");
  assert.equal(verdict("PATCH", `${ZONE}/settings/ssl`), "refuse");
  // Any other host: only the stage's own hosts and the known stage-only services.
  assert.equal(verdict("POST", "https://emulators.dev/billing/x/_emulate/seed"), "allow");
  assert.equal(verdict("POST", "https://app.rehearsal-2.example.dev/api/seed"), "allow");
  assert.equal(
    verdict("DELETE", "https://console.neon.tech/api/v2/projects/p/branches/b"),
    "refuse",
  );
  assert.equal(verdict("POST", "https://app.example.dev/api/anything"), "refuse");
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

test("a stage outside the disposable shapes, or without a stage domain, owns no hostname", () => {
  const named = (label: string, domain?: string) =>
    stageWriteVerdict(
      { ...scope, label, ...(domain ? { domain } : { domain: undefined }) },
      owned,
      "PUT",
      new URL(`${CF}/workers/domains`),
      { hostname: `${label}.example.dev`, service: "basalt-rehearsal-api-test-rehearsal-2-x1" },
    ).kind;
  // `test-app` must never reach `app.<production zone>`.
  assert.equal(named("app", "example.dev"), "refuse");
  assert.equal(named("rehearsal-2"), "refuse");
  assert.equal(named("rehearsal-2", "example.dev"), "allow");
});

const REGISTRY = "https://registry.cloudflare.com/v2/acct";
const DIGEST = `sha256:${"a".repeat(64)}`;
const teardown: StageScope = { ...scope, teardown: true, accountId: "acct" };
const teardownVerdict = (method: string, url: string, at: StageScope = teardown) =>
  stageWriteVerdict(at, () => false, method, new URL(url), undefined);

test("a rehearsal teardown deletes registry manifests only in repositories named for the stage", () => {
  const own = `${REGISTRY}/basalt-rehearsal-poolcontainer-test-rehearsal-2-abcdefghijklmnop`;
  assert.equal(teardownVerdict("DELETE", `${own}/manifests/${DIGEST}`).kind, "allow");
  assert.equal(teardownVerdict("DELETE", `${own}/manifests/latest`).kind, "allow");
  assert.equal(
    teardownVerdict(
      "DELETE",
      `${REGISTRY}/basalt-test-rehearsal-2-pool-runtime-blue/manifests/${DIGEST}`,
    ).kind,
    "allow",
  );
  for (const [method, url] of [
    // Another stage, one whose number starts the same, and production.
    [
      "DELETE",
      `${REGISTRY}/basalt-rehearsal-poolcontainer-test-rehearsal-20-abcdefghijklmnop/manifests/${DIGEST}`,
    ],
    ["DELETE", `${REGISTRY}/basalt-test-rehearsal-20-pool-runtime-blue/manifests/${DIGEST}`],
    [
      "DELETE",
      `${REGISTRY}/basalt-rehearsal-poolcontainer-test-rehearsal-3-abcdefghijklmnop/manifests/${DIGEST}`,
    ],
    ["DELETE", `${REGISTRY}/basalt-pool-production/manifests/${DIGEST}`],
    // Only a manifest or tag delete: no blob, upload, push or catalog write.
    ["DELETE", `${own}/blobs/${DIGEST}`],
    ["PUT", `${own}/manifests/latest`],
    ["POST", `${own}/blobs/uploads/`],
    ["PATCH", `${own}/blobs/uploads/session`],
    // A repository below another, or a name an encoded slash would turn into a path.
    ["DELETE", `${own}/nested/manifests/${DIGEST}`],
    [
      "DELETE",
      `${REGISTRY}/basalt-rehearsal-poolcontainer-test-rehearsal-2-abcdefghijklmnop%2Fx/manifests/${DIGEST}`,
    ],
    // The stage's repository name under another account.
    [
      "DELETE",
      `https://registry.cloudflare.com/v2/other/basalt-rehearsal-poolcontainer-test-rehearsal-2-abcdefghijklmnop/manifests/${DIGEST}`,
    ],
  ] as const)
    assert.deepEqual([method, url, teardownVerdict(method, url).kind], [method, url, "refuse"]);
  // Without the deployment account the guard cannot place the path, so nothing is deleted.
  const { accountId: _, ...unplaced } = teardown;
  assert.equal(teardownVerdict("DELETE", `${own}/manifests/${DIGEST}`, unplaced).kind, "refuse");
});

test("a registry delete outside a rehearsal stage's teardown is refused", () => {
  const url = `${REGISTRY}/basalt-rehearsal-poolcontainer-test-rehearsal-2-abcdefghijklmnop/manifests/${DIGEST}`;
  // The same stage, deploying or destroying its stacks rather than tearing down.
  assert.equal(teardownVerdict("DELETE", url, scope).kind, "refuse");
  // A stage that is not a rehearsal owns nothing by name, whatever the repository says.
  for (const stage of ["test-pr-7", "test-rehearsal-0", "test-rehearsal-2x", "production"])
    assert.equal(
      teardownVerdict("DELETE", `${REGISTRY}/basalt-${stage}-cell/manifests/${DIGEST}`, {
        ...teardown,
        stage,
        label: stage.replace(/^test-/u, ""),
      }).kind,
      "refuse",
      stage,
    );
});

test("a teardown deletes a container application only once Cloudflare names it for the stage", () => {
  const app = `${CF}/containers/applications/app-1`;
  // Even an application the stage's State records is proven by name during a teardown.
  assert.deepEqual(
    stageWriteVerdict(teardown, () => true, "DELETE", new URL(app), undefined),
    { kind: "prove", family: "container application", name: "app-1" },
  );
  assert.equal(teardownVerdict("PATCH", app).kind, "refuse");
  assert.equal(teardownVerdict("DELETE", `${app}/rollouts`).kind, "refuse");
  // Outside a teardown an unrecorded application stays refused.
  assert.equal(teardownVerdict("DELETE", app, scope).kind, "refuse");
  assert.equal(
    teardownVerdict("DELETE", app, { ...teardown, stage: "test-pr-7", label: "pr-7" }).kind,
    "refuse",
  );
});

test("a stage owns the zone routes its own Workers' rows record, and no other route", () => {
  const rows = [
    {
      resourceType: "Cloudflare.Worker",
      attr: {
        workerName: "basalt-rehearsal-api-x",
        routes: [
          { id: "route-own", pattern: "app.rehearsal-4.example.dev/*", zoneId: "zone" },
          { pattern: "no-id/*" },
        ],
      },
    },
    // Another type's nested `routes` never counts.
    {
      resourceType: "Cloudflare.DNS.Record",
      attr: { recordId: "rec-1", routes: [{ id: "route-dns" }] },
    },
  ];
  const stageOwned = ownIdentities(rows);
  assert.ok(stageOwned.includes("route-own"));
  assert.ok(!stageOwned.includes("route-dns"));
  const isOwned = (value: string) => stageOwned.includes(value);
  const remove = (id: string) =>
    stageWriteVerdict(scope, isOwned, "DELETE", new URL(`${ZONE}/workers/routes/${id}`), undefined)
      .kind;
  assert.equal(remove("route-own"), "allow");
  assert.equal(remove("route-production"), "refuse");
});

test("a stage may upload only the shared public trust root, byte for byte, and never owns or changes an mTLS certificate", async () => {
  const { readFileSync } = await import("node:fs");
  const root = readFileSync(
    new URL("../../.upstream/apps/hosted/cloud/certificates/isrg-root-x1.pem", import.meta.url),
    "utf8",
  );
  const post = (body: unknown) => verdict("POST", `${CF}/mtls_certificates`, body);
  // (a) the exact body
  assert.equal(post({ ca: true, certificates: root, name: "stage-ca" }), "allow");
  // (b) one byte different
  const flipped = root.replace("M", "N");
  assert.notEqual(flipped, root);
  assert.equal(post({ ca: true, certificates: flipped }), "refuse");
  assert.equal(post({ ca: true, certificates: `${root}\n` }), "refuse");
  // (c) a leaf certificate
  assert.equal(post({ ca: false, certificates: root }), "refuse");
  assert.equal(post(undefined), "refuse");
  // (d) the returned id is never the stage's: its rows add no identity, and no write of it passes,
  // whether the run deploys or tears down.
  const shared = [
    {
      resourceType: "Cloudflare.MtlsCertificate.MtlsCertificate",
      attr: { id: "cert-1", name: "n" },
    },
  ];
  assert.deepEqual(ownIdentities(shared), []);
  for (const isOwned of [() => false, () => true])
    for (const method of ["DELETE", "PUT", "PATCH", "POST"])
      assert.equal(
        stageWriteVerdict(scope, isOwned, method, new URL(`${CF}/mtls_certificates/cert-1`), {})
          .kind,
        "refuse",
        method,
      );
});
