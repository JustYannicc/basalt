import assert from "node:assert/strict";
import { test } from "node:test";
import { isCloudflareApiError, stageCloudflare } from "./api.mjs";
import {
  application,
  certificate,
  envelope,
  hyperdrive,
  listPage,
  namespace,
  refusalBody,
  script,
} from "./test/cloudflare-shapes.mjs";
import { fakeAccount } from "./test/fake-account.mjs";

const prefix = "basalt-emulated-upstream";
/** The stage's resources beside production's and another stage's. */
const account = () =>
  fakeAccount({
    live: {
      applications: [
        application({ id: "a1", name: `${prefix}-mock` }),
        application({ id: "a2", name: "basalt-production-poolcontainer" }),
        application({ id: "a3", name: `${prefix}x-mock` }),
      ],
      scripts: [script(`${prefix}-gateway`), script("basalt-production-poolworker")],
      namespaces: [
        namespace({ id: "n1", className: "Mock", script: `${prefix}-gateway` }),
        namespace({ id: "n2", className: "Pool", script: "basalt-production-poolworker" }),
        // A production Worker's namespace whose own name merely carries the prefix.
        namespace({
          id: "n3",
          className: "Pool",
          script: "basalt-production-poolworker",
          name: `${prefix}-lookalike`,
        }),
      ],
      drives: [
        hyperdrive({ id: "d1", name: `${prefix}-auth` }),
        hyperdrive({ id: "d2", name: "basalt-production" }),
      ],
      certificates: [certificate({ id: "c1", name: `${prefix}-ca` })],
    },
    bindings: { [`${prefix}-gateway`]: { DELETE_BY: "1" } },
    tags: {
      [`acct/${prefix}-mock`]: ["h1"],
      "acct/basalt-poolcontainer-production": ["p1"],
      [`other/${prefix}-mock`]: ["x1"],
    },
  });
const stage = (fetcher, options = {}) =>
  stageCloudflare({ accountId: "acct", token: "t", prefix, fetcher, ...options });
const answering = (response) => async () => response();

test("a call throws on any refusal, with codes and known fields but never the remote message", async () => {
  const fake = account();
  const listed = (await stage(fake.fetcher).inventory()).applications[0];
  const refused = stage(async (url, init) =>
    init.method === "PATCH"
      ? Response.json(
          refusalBody([{ code: 10021, message: "max_instances too high for token abc123secret" }]),
          { status: 400 },
        )
      : fake.fetcher(url, init),
  );
  const row = (await refused.inventory()).applications[0];
  assert.equal(row.id, listed.id);
  await assert.rejects(
    refused.change("applications", row, { method: "PATCH", body: {} }),
    (error) => {
      assert.equal(error.message, "Cloudflare PATCH containers/applications failed (400)");
      assert.deepEqual(error.diagnostic, {
        provider: "cloudflare",
        operation: "containers/applications",
        method: "PATCH",
        status: 400,
        codes: [10021],
        fields: ["max_instances"],
      });
      assert.ok(isCloudflareApiError(error));
      assert.doesNotMatch(JSON.stringify(error.diagnostic), /secret/u);
      return true;
    },
  );
  const failed = (response) => stage(answering(response)).subdomain();
  await assert.rejects(
    failed(() => Response.json(refusalBody([]))),
    /failed \(200\)/u,
  );
  await assert.rejects(
    failed(() => new Response("<html>x</html>")),
    /failed \(200\)/u,
  );
  await assert.rejects(
    failed(() => Response.json({}, { status: 403 })),
    /failed \(403\)/u,
  );
});

test("only a read of one resource answers absent; a listing never does", async () => {
  const fake = account();
  assert.equal(await stage(fake.fetcher).read("scripts", `${prefix}-other`, "/settings"), null);
  const lists = (response) => stage(answering(response)).inventory(["scripts"]);
  await assert.rejects(
    lists(() => Response.json({}, { status: 404 })),
    /failed \(404\)/u,
  );
  await assert.rejects(
    lists(() => Response.json(envelope(null))),
    /Unrecognized/u,
  );
  await assert.rejects(
    lists(() => Response.json(envelope({}))),
    /Unrecognized/u,
  );
  await assert.rejects(
    stage(answering(() => Response.json({}, { status: 403 }))).read("scripts", `${prefix}-gateway`),
    /Cloudflare GET workers\/scripts failed \(403\)/u,
  );
});

test("a listing follows total_pages where the API gives it", async () => {
  const pages = [];
  const paged = async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    pages.push(page);
    const rows = page === 2 ? [script(`${prefix}-gateway`)] : [script(`other-${page}`)];
    return Response.json(listPage(rows, { page, totalPages: 3 }));
  };
  const found = await stage(paged).inventory(["scripts"]);
  assert.deepEqual(pages, [1, 2, 3]);
  assert.deepEqual(
    found.scripts.map((row) => row.id),
    [`${prefix}-gateway`],
  );
});

test("an inventory holds only the stage's rows, and a namespace belongs to its Worker", async () => {
  const fake = account();
  const found = await stage(fake.fetcher).inventory([
    "applications",
    "namespaces",
    "scripts",
    "drives",
    "certificates",
  ]);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(found).map(([kind, rows]) => [kind, rows.map((row) => row.name ?? row.id)]),
    ),
    {
      applications: [`${prefix}-mock`],
      namespaces: [`${prefix}-gateway_Mock`],
      scripts: [`${prefix}-gateway`],
      drives: [`${prefix}-auth`],
      certificates: [`${prefix}-ca`],
    },
  );
  const images = await stage(fake.fetcher).images();
  assert.deepEqual(
    images.map((row) => [row.name, row.tags]),
    [[`${prefix}-mock`, ["h1"]]],
  );
});

test("nothing outside the stage is read, changed or deleted, and the refusal comes before any call", async () => {
  const fake = account();
  const api = stage(fake.fetcher);
  const found = await api.inventory();
  const before = fake.calls.length;
  const production = fake.live.applications.find((row) => row.id === "a2");
  const forged = { id: "a2", name: `${prefix}-mock` };
  for (const attempt of [
    () => api.remove("applications", production),
    () => api.remove("applications", forged),
    () => api.remove("applications", "a2"),
    () => api.remove("scripts", "basalt-production-poolworker"),
    () => api.read("scripts", "basalt-production-poolworker", "/settings"),
    () =>
      api.remove(
        "namespaces",
        fake.live.namespaces.find((row) => row.id === "n3"),
      ),
    () => api.change("applications", found.applications[0], { method: "DELETE" }),
    () => api.remove("workers/scripts", `${prefix}-gateway`),
    () =>
      api.removeImage({ name: "basalt-poolcontainer-production", path: "acct/x", tags: ["p1"] }),
  ])
    await assert.rejects(attempt(), /^Error: Refused/u);
  assert.equal(fake.calls.length, before);
  assert.equal(fake.live.applications.length, 3);
});

test("a stage's own rows are read back, changed and deleted by id", async () => {
  const fake = account();
  const api = stage(fake.fetcher);
  const found = await api.inventory(["applications", "namespaces", "scripts", "drives"]);
  const [app] = found.applications;
  assert.equal((await api.read("applications", app)).result.name, `${prefix}-mock`);
  const settings = await api.read("scripts", `${prefix}-gateway`, "/settings");
  assert.ok(settings.result.bindings.some((row) => row.name === "DELETE_BY" && row.text === "1"));
  await api.remove("namespaces", found.namespaces[0]);
  await api.remove("drives", found.drives[0]);
  await api.remove("applications", app);
  await api.remove("scripts", found.scripts[0]);
  assert.deepEqual(
    fake.calls
      .filter((call) => call.method === "DELETE")
      .map((call) => call.path.split("/").slice(5).join("/")),
    [
      "workers/durable_objects/namespaces/n1",
      "hyperdrive/configs/d1",
      "containers/applications/a1",
      `workers/scripts/${prefix}-gateway`,
    ],
  );
  assert.equal(api.owned(fake.live.applications[0].name), false);
  assert.equal(await api.subdomain(), "acct-sub");
  assert.deepEqual(new Set(await api.imageReferences()).size, 1);
});

test("a stage's images are deleted index first and leave every other repository", async () => {
  const fake = account();
  const api = stage(fake.fetcher);
  const [image] = await api.images(["pull", "push"]);
  await api.removeImage(image);
  const deleted = fake.calls.filter(
    (call) => call.method === "DELETE" && call.host === "registry.cloudflare.com",
  );
  assert.deepEqual(
    deleted.map((call) => call.path.split("/").at(-1)),
    [`sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`],
  );
  assert.ok(deleted.every((call) => call.path.startsWith(`/v2/acct/${prefix}-mock/`)));
  assert.deepEqual(await api.images(), [
    { name: `${prefix}-mock`, path: `acct/${prefix}-mock`, tags: [] },
  ]);
  assert.deepEqual(fake.live.tags["acct/basalt-poolcontainer-production"], ["p1"]);
  assert.deepEqual(fake.live.tags[`other/${prefix}-mock`], ["x1"]);
});

test("an empty or unrecognised registry answer stops the read instead of reading as empty", async () => {
  const fake = account();
  const catalog = (body) => async (url, init) =>
    new URL(url).pathname === "/v2/_catalog" ? Response.json(body) : fake.fetcher(url, init);
  await assert.rejects(stage(catalog({})).images(), /without its repository list/u);
  await assert.rejects(stage(catalog({ repositories: [7] })).images(), /without a name/u);
  const credentials = stage(async (url, init) =>
    url.endsWith("/credentials") ? Response.json({}, { status: 403 }) : fake.fetcher(url, init),
  );
  await assert.rejects(
    credentials.images(),
    /Cloudflare POST containers\/registries failed \(403\)/u,
  );
});

test("a path below a resource is one its kind names; nothing climbs out of it", async () => {
  const fake = account();
  const api = stage(fake.fetcher);
  const [app] = (await api.inventory(["applications"])).applications;
  const before = fake.calls.length;
  for (const attempt of [
    () => api.read("scripts", `${prefix}-gateway`, "/../basalt-production-poolworker/settings"),
    () => api.read("scripts", `${prefix}-gateway`, "/%2e%2e/basalt-production-poolworker"),
    () =>
      api.change("scripts", `${prefix}-gateway`, {
        method: "PUT",
        path: "/%2e%2e/basalt-production-poolworker",
        body: {},
      }),
    () => api.read("applications", app, "/../a2"),
    () => api.change("applications", app, { method: "POST", path: "/settings", body: {} }),
    () => api.read("drives", app, "/rollouts"),
    () => api.read("scripts", `${prefix}-gateway`, ["/settings"]),
  ])
    await assert.rejects(attempt(), /^Error: Refused/u);
  assert.equal(fake.calls.length, before);
});

test("a listed row is addressed as it was listed, and only as its own kind", async () => {
  const fake = account();
  const api = stage(fake.fetcher);
  const found = await api.inventory(["applications", "certificates"]);
  const [app] = found.applications;
  const [certificate] = found.certificates;
  const before = fake.calls.length;
  for (const attempt of [
    () => api.remove("applications", certificate),
    () => api.remove("certificates", app),
    () => api.remove("scripts", app),
  ])
    await assert.rejects(attempt(), /^Error: Refused/u);
  assert.equal(fake.calls.length, before);
  // Pointing a listed row at production after its listing still deletes only what was listed.
  app.id = "a2";
  app.name = "basalt-production-poolcontainer";
  await api.remove("applications", app);
  assert.deepEqual(
    fake.live.applications.map((row) => row.id),
    ["a2", "a3"],
  );
  assert.deepEqual(
    fake.calls.slice(before).map((call) => `${call.method} ${call.path.split("/").slice(5).join("/")}`),
    ["DELETE containers/applications/a1"],
  );
});

test("a found image is deleted from the repository it was found in, whatever the row says", async () => {
  const fake = account();
  const api = stage(fake.fetcher);
  const [image] = await api.images(["pull", "push"]);
  image.path = "acct/basalt-poolcontainer-production";
  image.tags = ["p1"];
  await api.removeImage(image);
  const reached = fake.calls.filter(
    (call) => call.host === "registry.cloudflare.com" && call.path.includes("/manifests/"),
  );
  assert.ok(reached.length > 0);
  assert.ok(reached.every((call) => call.path.startsWith(`/v2/acct/${prefix}-mock/manifests/`)));
  assert.deepEqual(fake.live.tags["acct/basalt-poolcontainer-production"], ["p1"]);
  assert.deepEqual(fake.live.tags[`acct/${prefix}-mock`], []);
});

test("a predicate that throws is refused without its message", () => {
  const fake = account();
  assert.throws(
    () =>
      stage(fake.fetcher, {
        owns: () => {
          throw new Error("token abc123secret");
        },
      }),
    (error) => {
      assert.ok(isCloudflareApiError(error));
      assert.match(error.message, /^Refused stage ownership/u);
      assert.doesNotMatch(error.message, /secret/u);
      return true;
    },
  );
  assert.equal(fake.calls.length, 0);
});
