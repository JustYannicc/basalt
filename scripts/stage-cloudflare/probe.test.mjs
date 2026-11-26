// Refusals checked only by what reaches the account: whatever a stage tool hands the stage
// API, no request outside the stage's own resources is sent.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { stageCloudflare } from "./api.mjs";
import { stageRequests, unchangedWhenParsed } from "./request.mjs";
import {
  application,
  certificate,
  hyperdrive,
  listPage,
  namespace,
  script,
} from "./test/cloudflare-shapes.mjs";
import { accountId, outsideCalls, sharedAccount, stageReach } from "./test/stage-reach.mjs";

const prefix = "basalt-180-scale";
const setup = () => {
  const fake = sharedAccount(prefix);
  const reach = stageReach(fake, prefix);
  const api = stageCloudflare({ accountId, token: "t", prefix, fetcher: fake.fetcher });
  return { fake, reach, api };
};
const settle = (attempt) => attempt().catch(() => undefined);

test("refuses any path below a stage's own Worker", async () => {
  const { fake, reach, api } = setup();
  for (const below of [
    "/../basalt-production-poolworker/settings",
    "/%2e%2e/basalt-production-poolworker",
    "/%2E%2E/basalt-production-poolworker/settings",
    "/..%2fbasalt-production-poolworker",
  ])
    await settle(() => api.read("scripts", `${prefix}-gateway`, below));
  assert.deepEqual(outsideCalls(fake, prefix, reach), []);
  assert.ok(fake.live.scripts.some((row) => row.id === "basalt-production-poolworker"));
});

test("refuses a listed row changed after its listing", async () => {
  const { fake, reach, api } = setup();
  const [app] = (await api.inventory(["applications"])).applications.filter(
    (row) => row.id === "own-app",
  );
  app.id = "prod-app";
  await settle(() => api.remove("applications", app));
  app.id = "own-app";
  app.name = "basalt-production-poolcontainer";
  await settle(() => api.remove("applications", app));
  assert.deepEqual(outsideCalls(fake, prefix, reach), []);
  assert.ok(fake.live.applications.some((row) => row.id === "prod-app"));
});

test("refuses a found image changed after it was found", async () => {
  const { fake, reach, api } = setup();
  const [image] = await api.images();
  image.path = `${accountId}/basalt-poolcontainer-production`;
  image.tags = ["p1"];
  await settle(() => api.removeImage(image));
  image.name = "basalt-poolcontainer-production";
  await settle(() => api.removeImage(image));
  assert.deepEqual(outsideCalls(fake, prefix, reach), []);
  assert.deepEqual(fake.live.tags[`${accountId}/basalt-poolcontainer-production`], ["p1"]);
});

test("the choke point derives ownership from a registered prefix and hands out no registry credential", async () => {
  const { fake, reach } = setup();
  const options = { accountId, token: "t", fetcher: fake.fetcher, signal: () => undefined };
  for (const given of [
    { ...options, owned: () => true },
    { ...options, prefix, owned: () => true },
    { ...options, prefix: "basalt-route-scratch" },
    { ...options, prefix: "basalt-production" },
    options,
  ])
    assert.throws(() => stageRequests(given), /^Error: Refused/u);
  const { send } = stageRequests({ ...options, prefix });
  const apps = await send({ kind: "applications", operation: "list" });
  assert.ok(apps.every((row) => row.name.startsWith(`${prefix}-`)));
  for (const request of [
    { kind: "account", operation: "credentials", access: "push" },
    { kind: "account", operation: "credentials", access: "pull" },
    { kind: "account", operation: "credentials" },
    { kind: "scripts", operation: "settings", target: "basalt-route-scratch-1-gateway" },
  ])
    await assert.rejects(send(request), /^Error: Refused/u, JSON.stringify(request));
  // The registry is used, so a credential is minted, and none of it reaches the caller.
  const api = stageCloudflare({ ...options, prefix });
  const returned = [await api.images(), await api.inventory(), await api.imageReferences()];
  const [image] = returned[0];
  await api.removeImage(image);
  assert.ok(fake.calls.some((call) => call.path.endsWith("/credentials")));
  const credential = Buffer.from("<name>:<secret>").toString("base64");
  for (const secret of ["Basic ", "<secret>", credential])
    assert.ok(!JSON.stringify(returned).includes(secret), secret);
  assert.deepEqual(outsideCalls(fake, prefix, reach), []);
});

/** A fetcher that answers one listing with extra rows, as a listing that lies about ids would. */
const listing = (fake, path, extra) => async (url, init) => {
  const response = await fake.fetcher(url, init);
  if (!new URL(url).pathname.endsWith(`/accounts/${accountId}/${path}`)) return response;
  const body = await response.json();
  return Response.json({ ...body, result: [...body.result, ...extra] });
};

test("a listed row is changed or deleted only when its id answers for its own name", async () => {
  const cases = [
    [
      "applications",
      "containers/applications",
      application({ id: "prod-app", name: `${prefix}-evil` }),
    ],
    ["drives", "hyperdrive/configs", hyperdrive({ id: "prod-drive", name: `${prefix}-evil` })],
    ["certificates", "mtls_certificates", certificate({ id: "prod-ca", name: `${prefix}-evil` })],
  ];
  for (const [kind, path, lie] of cases) {
    const { fake, reach } = setup();
    const api = stageCloudflare({
      accountId,
      token: "t",
      prefix,
      fetcher: listing(fake, path, [lie]),
    });
    const row = (await api.inventory([kind]))[kind].find((found) => found.id === lie.id);
    assert.ok(row, `${kind}: the lying row is listed as the stage's`);
    const attempts = [() => api.remove(kind, row)];
    if (kind === "applications")
      attempts.push(
        () => api.patch(kind, row, { max_instances: 0 }),
        () => api.rollout(kind, row, { description: "x", strategy: "rolling" }),
        () => api.read(kind, row),
      );
    for (const attempt of attempts) await assert.rejects(attempt(), /^Error: Refused/u, kind);
    // Only the read-back went to the id, and it changed nothing.
    const sent = fake.calls.filter(
      (call) => call.path.endsWith(`/${lie.id}`) || call.path.includes(`/${lie.id}/`),
    );
    assert.deepEqual([...new Set(sent.map((call) => call.method))], ["GET"], kind);
    assert.deepEqual(outsideCalls(fake, prefix, reach), [], kind);
    assert.ok(
      fake.live[kind].some((found) => found.id === lie.id),
      kind,
    );
  }
  // A namespace is never addressed, whatever its listing says.
  const { fake, reach } = setup();
  const lies = [
    namespace({
      id: "prod-ns",
      className: "Pool",
      script: `${prefix}-gateway`,
      name: "basalt-production-poolworker_Pool",
    }),
    { id: "prod-ns", script: "", name: `${prefix}-orphan`, class: "Pool" },
  ];
  const api = stageCloudflare({
    accountId,
    token: "t",
    prefix,
    fetcher: listing(fake, "workers/durable_objects/namespaces", lies),
  });
  for (const row of (await api.inventory(["namespaces"])).namespaces)
    await assert.rejects(api.remove("namespaces", row), /^Error: Refused/u);
  assert.ok(!fake.calls.some((call) => call.method === "DELETE"));
  assert.deepEqual(outsideCalls(fake, prefix, reach), []);
});

test("only a real HTTP Response is read, once, and nothing the answer object defines is consulted", async () => {
  const { fake, reach } = setup();
  let reads = 0;
  const shifting = {
    ...script("x"),
    get id() {
      reads++;
      return reads === 2 ? "basalt-production-poolworker" : `${prefix}-gateway`;
    },
  };
  const scriptsListing = (url, init) =>
    new URL(url).pathname.endsWith("/workers/scripts") && (init.method ?? "GET") === "GET";
  const lookalike = stageCloudflare({
    accountId,
    token: "t",
    prefix,
    fetcher: async (url, init) =>
      scriptsListing(url, init)
        ? { ok: true, status: 200, json: async () => listPage([shifting]) }
        : fake.fetcher(url, init),
  });
  await assert.rejects(lookalike.inventory(["scripts"]), /^Error: Refused/u);
  // A real Response whose own json() and status say something else is read as it really is.
  const overridden = stageCloudflare({
    accountId,
    token: "t",
    prefix,
    fetcher: async (url, init) => {
      const response = await fake.fetcher(url, init);
      if (!scriptsListing(url, init)) return response;
      Object.defineProperty(response, "json", {
        value: async () => listPage([shifting]),
      });
      Object.defineProperty(response, "status", { value: 200 });
      return response;
    },
  });
  const { scripts } = await overridden.inventory(["scripts"]);
  assert.ok(scripts.every((row) => row.id.startsWith(`${prefix}-gateway`)));
  await overridden.remove(
    "scripts",
    scripts.find((row) => row.id === `${prefix}-gateway`),
  );
  assert.equal(reads, 0);
  assert.deepEqual(outsideCalls(fake, prefix, reach), []);
  assert.ok(fake.live.scripts.some((row) => row.id === "basalt-production-poolworker"));
});

test("the sender refuses a URL that changes when parsed or holds a dot segment", async () => {
  // Every check before the sender already keeps dots and separators out of names and ids, so this
  // last one is reached only by its own inputs and by the sender's one call of the fetcher.
  const source = readFileSync(new URL("request.mjs", import.meta.url), "utf8");
  assert.match(
    source,
    /async function exchange\(url, [^)]*\) \{\n\s+unchangedWhenParsed\(url\);[^]*?await fetcher\(url, init\)/u,
  );
  const { fake, api } = setup();
  await api.inventory(["applications", "scripts", "drives", "certificates"]);
  const [image] = await api.images();
  await api.removeImage(image);
  await api.settings(`${prefix}-gateway`);
  for (const { url } of fake.calls) assert.equal(unchangedWhenParsed(url), url);
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  for (const url of [
    `${base}/containers/applications/own-app/../prod-app`,
    `${base}/containers/applications/own-app/%2e%2e/prod-app`,
    `${base}/containers/applications/own-app/.%2E/prod-app`,
    `${base}/containers/applications/%2e`,
    `${base}/containers/applications/./own-app`,
    `${base}/containers/applications/own-app\\..\\prod-app`,
    `${base}/containers/applications/own\tapp`,
    `${base}/containers/applications/own app`,
    `https://API.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
    `https://api.cloudflare.com:443/client/v4/accounts/${accountId}/workers/subdomain`,
    `https://registry.cloudflare.com/v2/${accountId}/${prefix}-pool/manifests/..`,
    "registry.cloudflare.com/v2/_catalog",
    "",
  ])
    assert.throws(() => unchangedWhenParsed(url), /^Error: Refused: the request's URL/u, url);
});
