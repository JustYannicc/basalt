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
  // The first page asks for its own size; each later one sends back the registry's link parameters.
  assert.deepEqual(
    lists.map((params) => params.get("n")),
    ["1000", "2", "2"],
  );
});

test("a registry that pages by its own cursor is read to the end", async () => {
  const fake = fakeAccount({
    tags: { [`acct/${prefix}-mock`]: longTagList },
    tagPageSize: 2,
    tagCursor: "opaque",
  });
  const [image] = await stage(fake.fetcher).images();
  assert.deepEqual([...image.tags].sort(), [...longTagList].sort());
  const lists = fake.calls.filter((call) => call.path.endsWith("/tags/list"));
  assert.deepEqual(
    lists.map((call) => new URL(call.url).searchParams.get("cursor")),
    [null, "Mg", "NA"],
  );
});

/** A registry whose tag lists answer `pages` in turn: `[tags, link?, status?]` each. */
const scripted = (pages) => {
  const fake = paged();
  const sent = [];
  let index = 0;
  const fetcher = async (url, init) => {
    if (!new URL(url).pathname.endsWith("/tags/list")) return fake.fetcher(url, init);
    sent.push(url);
    const [tags, link, status = 200] = pages[Math.min(index++, pages.length - 1)];
    return Response.json(
      { name: `acct/${prefix}-mock`, tags },
      { status, headers: link === undefined ? {} : { link } },
    );
  };
  return { fetcher, sent };
};
const stopOf = async (pages) => {
  const { fetcher, sent } = scripted(pages);
  const error = await stage(fetcher)
    .images()
    .then(
      () => assert.fail("the read did not stop"),
      (caught) => caught,
    );
  return { error, record: error.record?.tagRead, sent };
};
const next = (query) => `</v2/acct/${prefix}-mock/tags/list?${query}>; rel="next"`;

test("a tag already listed and a tag it cannot name are two stops, each with its page and count", async () => {
  // A registry that ignores the cursor answers its first page again.
  const again = await stopOf([[["h1", "h2"], next("n=2&last=h2")]]);
  assert.equal(
    again.error.message,
    "A registry tag list answered a tag it had already listed (page 2, after 2 tags)",
  );
  assert.equal(again.record.rule, "already-listed");
  assert.equal(again.record.where, "earlier-page");
  assert.equal(again.record.sameAsFirstPage, true);
  assert.deepEqual(
    again.record.pages.map(({ status, tags, next: more }) => [status, tags, more]),
    [
      [200, 2, true],
      [200, 2, true],
    ],
  );
  const twice = await stopOf([[["h1", "h1"]]]);
  assert.equal(twice.record.where, "same-page");
  assert.equal(twice.record.sameAsFirstPage, false);

  const unnamed = await stopOf([[["h1", "h2"], next("last=h2")], [["sha256:Ab1"]]]);
  assert.equal(
    unnamed.error.message,
    "A registry tag list answered a tag it cannot name (page 2, after 2 tags)",
  );
  assert.deepEqual(unnamed.record.tag, {
    length: 10,
    classes: ["upper", "lower", "digit", "colon"],
    first: "lower",
  });
  // Closed facts only: no tag, cursor value or URL reaches the record.
  assert.doesNotMatch(JSON.stringify(unnamed.record), /h1|h2|sha256|Ab1|acct|https?:|\/v2/u);
});

test("a next link gives only its parameters; host and path stay the stage's own", async () => {
  const { sent, record } = await stopOf([
    [["h1"], '<https://elsewhere.example/v2/other/repo/tags/list?last=h1&n=1>; REL="Next"'],
    [["h2"], "<../../x?last=..%2F..%2Fy>; rel=next"],
    [["h3"], next("last=h3")],
    [["h1"]],
  ]);
  const own = new URL(sent[0]);
  for (const url of sent.map((each) => new URL(each))) {
    assert.equal(url.host, own.host);
    assert.equal(url.pathname, own.pathname);
  }
  // A value that looks like a path stays a query value.
  assert.equal(new URL(sent[2]).searchParams.get("last"), "../../y");
  assert.equal(record.pages[0].link.host, "other");
  assert.equal(record.pages[0].link.path, "other");
  assert.equal(record.pages[1].link.path, "other");
});

test("a next link that is not a few plain cursor values stops the read", async () => {
  for (const link of [
    "<?last=a%20b>; rel=next",
    "<?last=a&last=b>; rel=next",
    "<?a=1&b=2&c=3&d=4&e=5>; rel=next",
    "</v2/x/tags/list>; rel=next",
    "<http://[bad>; rel=next",
    'rel="next"',
  ]) {
    const { error, record } = await stopOf([[["h1"], link]]);
    assert.equal(
      error.message,
      "A registry tag list's next link is not plain cursor values (page 1, after 1 tag)",
      link,
    );
    assert.equal(record.rule, "link-not-plain");
  }
});

test("a later page that fails, cannot be sent or answers without its tags stops with its page and record", async () => {
  const failed = await stopOf([
    [["h1"], next("last=h1")],
    [[], undefined, 500],
  ]);
  assert.equal(
    failed.error.message,
    "A registry tag list's later page answered HTTP 500 (page 2, after 1 tag)",
  );
  assert.equal(failed.record.rule, "later-page-failed");
  assert.equal(failed.record.pages[1].status, 500);
  // What the stage sent back is in the record of the page before.
  assert.equal(failed.record.pages[0].link.params[0].name, "last");

  const fake = paged();
  let lists = 0;
  const unsent = async (url, init) => {
    if (!new URL(url).pathname.endsWith("/tags/list")) return fake.fetcher(url, init);
    if (lists++) throw new TypeError("fetch failed: getaddrinfo ENOTFOUND registry.example");
    return Response.json({ tags: ["h1"] }, { headers: { link: next("last=h1") } });
  };
  const error = await stage(unsent)
    .images()
    .then(
      () => assert.fail("the read did not stop"),
      (caught) => caught,
    );
  assert.equal(
    error.message,
    "A registry tag list's later page could not be read (page 2, after 1 tag)",
  );
  assert.equal(error.record.tagRead.cause, "unsent");
  assert.doesNotMatch(JSON.stringify(error.record), /registry\.example|ENOTFOUND/u);

  const bare = async (url, init) => {
    if (!new URL(url).pathname.endsWith("/tags/list")) return fake.fetcher(url, init);
    return lists++ % 2
      ? Response.json({ errors: [] })
      : Response.json({ tags: ["h1"] }, { headers: { link: next("last=h1") } });
  };
  lists = 0;
  const missing = await stage(bare)
    .images()
    .then(
      () => assert.fail("the read did not stop"),
      (caught) => caught,
    );
  assert.equal(missing.record.tagRead.cause, "no-tags");
});

test("a next link is read as written: a plus stays a plus, quoted parameters are skipped, a fragment stops", async () => {
  const plus = await stopOf([[["h1"], next("cursor=ab+cd")], [["h1"]]]);
  assert.equal(new URL(plus.sent[1]).search, "?cursor=ab%2Bcd");
  assert.ok(plus.record.pages[0].link.params[0].value.classes.includes("plus"));
  for (const link of [
    `<?last=h1>; title="a, b; c"; rel="next"`,
    "<?last=h1>; rel='next'",
    '<?last=h1>; rel="prev next"',
  ]) {
    const { sent } = await stopOf([[["h1"], link], [["h1"]]]);
    assert.equal(new URL(sent[1]).search, "?last=h1", link);
  }
  const fragment = await stopOf([[["h1"], "<?last=h1#x>; rel=next"]]);
  assert.equal(fragment.record.rule, "link-not-plain");
  assert.equal(fragment.record.pages[0].link.fragment, true);
  // An empty page that offers another still records what its link offered.
  const empty = await stopOf([[[], next("last=h0")]]);
  assert.equal(empty.record.rule, "next-after-empty");
  assert.equal(empty.record.pages[0].link.target, "present");
});

test("a 404 on a later page stops the read instead of ending the list", async () => {
  const { error, record } = await stopOf([
    [["h1"], next("last=h1")],
    [[], undefined, 404],
  ]);
  assert.equal(
    error.message,
    "A registry tag list's later page answered 404 (page 2, after 1 tag)",
  );
  assert.equal(record.rule, "gone-on-later-page");
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
  await assert.rejects(stage(page(["h1", "h1"], false)).images(), /had already listed/u);
  await assert.rejects(stage(page(["../x"], false)).images(), /cannot name/u);
  await assert.rejects(stage(page([], true)).images(), /another page after an empty one/u);
  // The same page offered forever repeats its tags on the second read.
  await assert.rejects(stage(page(["h1"], true)).images(), /had already listed \(page 2/u);
});
