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
  await assert.rejects(refused.patch("applications", row, {}), (error) => {
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
  });
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
  assert.equal(await stage(fake.fetcher).settings(`${prefix}-other`), null);
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
    stage(answering(() => Response.json({}, { status: 403 }))).settings(`${prefix}-gateway`),
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
    () => api.settings("basalt-production-poolworker"),
    () =>
      api.remove(
        "namespaces",
        fake.live.namespaces.find((row) => row.id === "n3"),
      ),
    () => api.patch("namespaces", found.namespaces[0], {}),
    () => api.settings(found.applications[0]),
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
  const settings = await api.settings(`${prefix}-gateway`);
  assert.ok(settings.result.bindings.some((row) => row.name === "DELETE_BY" && row.text === "1"));
  // A namespace goes with its Worker; it is never addressed on its own.
  await assert.rejects(api.remove("namespaces", found.namespaces[0]), /^Error: Refused/u);
  await api.remove("drives", found.drives[0]);
  await api.remove("applications", app);
  await api.remove("scripts", found.scripts[0]);
  assert.deepEqual(
    fake.calls
      .filter((call) => call.method === "DELETE")
      .map((call) => call.path.split("/").slice(5).join("/")),
    ["hyperdrive/configs/d1", "containers/applications/a1", `workers/scripts/${prefix}-gateway`],
  );
  assert.equal(api.owned(fake.live.applications[0].name), false);
  assert.equal(await api.subdomain(), "acct-sub");
  assert.deepEqual(new Set(await api.imageReferences()).size, 1);
});

test("a stage's images are deleted index first and leave every other repository", async () => {
  const fake = account();
  const api = stage(fake.fetcher);
  const [image] = await api.images();
  await api.removeImage(image);
  const deleted = fake.calls.filter(
    (call) => call.method === "DELETE" && call.host === "registry.cloudflare.com",
  );
  assert.deepEqual(
    deleted.map((call) => call.path.split("/").at(-1)),
    [`sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`],
  );
  assert.ok(deleted.every((call) => call.path.startsWith(`/v2/acct/${prefix}-mock/`)));
  assert.deepEqual(await api.images(), [{ name: `${prefix}-mock`, tags: [] }]);
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

test("a listed row is addressed only as its own kind", async () => {
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

/** The stage's image with more tags than one registry page holds, one of them dotted. */
const longTagList = ["h1", "h2", "cache.v1", "h3", "h4"];
const paged = () =>
  fakeAccount({
    tags: { [`acct/${prefix}-mock`]: longTagList, "acct/basalt-poolcontainer-production": ["p1"] },
    tagPageSize: 2,
  });

test("a tag list is read page after page until the registry offers no next page", async () => {
  const fake = paged();
  const [image] = await stage(fake.fetcher).images();
  assert.deepEqual([...image.tags].sort(), [...longTagList].sort());
  const lists = fake.calls
    .filter((call) => call.path.endsWith("/tags/list"))
    .map((call) => new URL(call.url).searchParams);
  assert.equal(lists.length, 3);
  assert.deepEqual(
    lists.map((params) => params.get("last")),
    [null, "h1", "h3"],
  );
  assert.ok(lists.every((params) => params.get("n") === "1000"));
});

test("a stage's image with a long tag list is deleted, dotted tags included", async () => {
  const fake = paged();
  const api = stage(fake.fetcher);
  const [image] = await api.images();
  await api.removeImage(image);
  assert.deepEqual(await api.images(), [{ name: `${prefix}-mock`, tags: [] }]);
  assert.deepEqual(fake.live.tags["acct/basalt-poolcontainer-production"], ["p1"]);
});

test("a tag list that repeats a tag, names one outside the grammar or never ends stops the read", async () => {
  const fake = paged();
  const page = (tags, next) => async (url, init) =>
    new URL(url).pathname.endsWith("/tags/list")
      ? Response.json(
          { name: `acct/${prefix}-mock`, tags },
          next ? { headers: { link: '</v2/x/tags/list?n=1&last=h1>; rel="next"' } } : {},
        )
      : fake.fetcher(url, init);
  await assert.rejects(stage(page(["h1", "h1"], false)).images(), /already listed or cannot name/u);
  await assert.rejects(stage(page(["../x"], false)).images(), /already listed or cannot name/u);
  await assert.rejects(stage(page([], true)).images(), /another page after an empty one/u);
  // The same page offered forever repeats its tags on the second read.
  await assert.rejects(stage(page(["h1"], true)).images(), /already listed or cannot name/u);
});
