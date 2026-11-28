// What a stage may send as the body of a patch or a rollout: exactly the fields the scale test's
// resize sends (scripts/scale-test/run.mjs), with nothing that names another resource, and a
// configuration that differs from the application's own listed one only in its instance type.
// e2e/scale-test.test.mjs runs the real resize through the scale test's own transport.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stageCloudflare } from "./api.mjs";
import { accountId, outsideCalls, sharedAccount } from "./test/stage-reach.mjs";

const prefix = "basalt-180-scale";

async function stage() {
  const fake = sharedAccount(prefix);
  const api = stageCloudflare({ accountId, token: "t", prefix, fetcher: fake.fetcher });
  const { applications } = await api.inventory(["applications"]);
  return { fake, api, app: applications.find((row) => row.id === "own-app") };
}

/** The bodies the scale test's resize sends for `app`, as run.mjs builds them. */
const resize = (app, size = "basic") => {
  const configuration = { ...app.configuration, instance_type: size };
  return {
    patch: { max_instances: 1, configuration },
    rollout: {
      description: "Scale test instance size update",
      strategy: "rolling",
      kind: "full_auto",
      step_percentage: 100,
      target_configuration: configuration,
    },
  };
};

// The shape of a Secrets Store reference production's pool application carries.
const secret = {
  name: "POOL_SECRET",
  secret_name: "basalt-production-pool-secret",
  store_id: "<store id>",
  type: "secrets_store_secret",
};
/** Changes to a legitimate configuration that a stage may not send. */
const hostileConfigurations = (own) => [
  { secrets: [secret] },
  { secrets: [] },
  { ssh_public_key_ids: ["<key id>"] },
  { bindings: [{ type: "durable_object_namespace", namespace_id: "prod-ns" }] },
  { durable_objects: { namespace_id: "prod-ns" } },
  { labels: [{ name: "x", value: "y" }] },
  { image: "registry.cloudflare.com/acct/basalt-poolcontainer-production:p1" },
  { image: `${own.image}x` },
  { environment_variables: [{ name: "POOL_SECRET", value: "x" }] },
  { disk: { ...own.disk, secret: "x" } },
  { observability: { logs: { enabled: true, destinations: ["prod"] } } },
  { network: { ...own.network, assign_ipv4: "account" } },
  { instance_type: "standard-9" },
  { instance_type: ["basic"] },
  { ["__proto__"]: { secrets: [secret] } },
];
/** Bodies of each operation that a stage may not send, beside the hostile configurations. */
const hostileBodies = (operation, app) => {
  const legit = resize(app)[operation];
  const field = operation === "patch" ? "configuration" : "target_configuration";
  return [
    ...hostileConfigurations(app.configuration).map((change) => ({
      ...legit,
      [field]: { ...legit[field], ...change },
    })),
    { ...legit, secrets: [secret] },
    { ...legit, id: "prod-app" },
    { ...legit, application_id: "prod-app" },
    { ...legit, name: "basalt-production-poolcontainer" },
    { ...legit, durable_objects: { namespace_id: "prod-ns" } },
    { ...legit, constraints: { regions: ["WEUR"] } },
    { ...legit, [operation === "patch" ? "target_configuration" : "configuration"]: legit[field] },
    { ...legit, [field]: [legit[field]] },
    { ...legit, [field]: "x" },
    ...(operation === "patch"
      ? [
          { ...legit, max_instances: -1 },
          { ...legit, max_instances: "1" },
        ]
      : [
          { ...legit, strategy: "immediate" },
          { ...legit, step_percentage: 101 },
          { ...legit, description: 7 },
        ]),
    undefined,
    null,
    [],
    "{}",
  ];
};

for (const operation of ["patch", "rollout"])
  test(`a ${operation} body naming a secret, key, binding or other resource is refused before sending`, async () => {
    const { fake, api, app } = await stage();
    const sent = fake.calls.length;
    for (const body of hostileBodies(operation, app))
      await assert.rejects(
        api[operation]("applications", app, body),
        /^Error: Refused: /u,
        JSON.stringify(body),
      );
    assert.equal(fake.calls.length, sent, "nothing was sent");
  });

test("a refused body names the field it refused", async () => {
  const { api, app } = await stage();
  const { patch, rollout } = resize(app);
  await assert.rejects(
    api.patch("applications", app, {
      ...patch,
      configuration: { ...patch.configuration, secrets: [secret] },
    }),
    /^Error: Refused: a patch body takes no configuration\.secrets field$/u,
  );
  await assert.rejects(
    api.rollout("applications", app, {
      ...rollout,
      target_configuration: { ...rollout.target_configuration, image: "elsewhere" },
    }),
    /^Error: Refused: a rollout body's target_configuration\.image is not the application's own$/u,
  );
});

test("the scale test's resize bodies are sent as they were checked", async () => {
  const { fake, api, app } = await stage();
  for (const size of ["lite", "basic", "standard-2"]) {
    const { patch, rollout } = resize(app, size);
    await api.patch("applications", app, patch);
    await api.rollout("applications", app, rollout).catch(() => undefined);
    const bodies = fake.calls.filter((call) => call.body !== undefined);
    assert.deepEqual(
      bodies.slice(-2).map((call) => [call.method, JSON.parse(call.body)]),
      [
        ["PATCH", JSON.parse(JSON.stringify(patch))],
        ["POST", JSON.parse(JSON.stringify(rollout))],
      ],
      size,
    );
  }
  // The legitimate partial bodies the stage tests send also pass.
  await api.patch("applications", app, { max_instances: 1 });
  await api.rollout("applications", app, { description: "x" }).catch(() => undefined);
  assert.deepEqual(outsideCalls(fake, prefix), []);
});

test("a body is sent as it was checked, whatever its getters answer later", async () => {
  const { fake, api, app } = await stage();
  let reads = 0;
  const body = {
    get max_instances() {
      reads += 1;
      return reads === 1 ? 1 : { secrets: [secret] };
    },
  };
  await api.patch("applications", app, body);
  const [patch] = fake.calls.filter((call) => call.method === "PATCH");
  assert.deepEqual(JSON.parse(patch.body), { max_instances: 1 });
});

test("a configuration changed after its listing is checked against the listing", async () => {
  const { api, app } = await stage();
  const { patch } = resize(app);
  app.configuration.image = "registry.cloudflare.com/acct/basalt-poolcontainer-production:p1";
  try {
    await assert.rejects(
      api.patch("applications", app, resize(app).patch),
      /^Error: Refused: a patch body's configuration\.image is not the application's own$/u,
    );
  } finally {
    app.configuration.image = patch.configuration.image;
  }
  await api.patch("applications", app, patch);
});

test("a listing that lies about a configuration cannot make another application's fields the stage's own", async () => {
  const fake = sharedAccount(prefix);
  const foreign = "registry.cloudflare.com/acct/basalt-poolcontainer-production:p1";
  // The listing alone claims the stage's application runs another application's image; its id
  // answers honestly in the read-back.
  const fetcher = async (url, init) => {
    const response = await fake.fetcher(url, init);
    if (!new URL(url).pathname.endsWith(`/accounts/${accountId}/containers/applications`))
      return response;
    const body = await response.json();
    const result = body.result.map((row) =>
      row.id === "own-app"
        ? { ...row, configuration: { ...row.configuration, image: foreign } }
        : row,
    );
    return Response.json({ ...body, result });
  };
  const api = stageCloudflare({ accountId, token: "t", prefix, fetcher });
  const { applications } = await api.inventory(["applications"]);
  const app = applications.find((row) => row.id === "own-app");
  assert.equal(app.configuration.image, foreign);
  await assert.rejects(
    api.patch("applications", app, resize(app).patch),
    /^Error: Refused: a patch body's configuration\.image is not the application's own$/u,
  );
  assert.deepEqual(
    fake.calls.filter((call) => call.method !== "GET"),
    [],
  );
});
