// Every operation the stage API and its choke point declare, each handed hostile input, with every
// request the account received judged by an oracle that knows only the stage's own resources.
// Coverage is by construction: an operation, kind or export added without a case here fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as apiModule from "./api.mjs";
import { STAGE_PREFIXES, stageOwnership } from "./ownership.mjs";
import * as registryModule from "./registry.mjs";
import * as requestModule from "./request.mjs";
import { productionNames } from "./test/production-names.mjs";
import {
  accountId,
  lookAlikes,
  outsideCalls,
  sharedAccount,
  stageReach,
} from "./test/stage-reach.mjs";

const { stageCloudflare } = apiModule;
const { KINDS, stageRequests } = requestModule;
const source = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const MODULE = ["api.mjs", "request.mjs", "registry.mjs", "ownership.mjs"];
const count = (text, pattern) => [...text.matchAll(pattern)].length;

test("exactly one place in the module calls the fetcher, and nothing else holds it", () => {
  const calls = Object.fromEntries(
    MODULE.map((file) => [file, count(source(file), /\bfetcher\s*\(/gu)]),
  );
  assert.deepEqual(calls, {
    "api.mjs": 0,
    "request.mjs": 1,
    "registry.mjs": 0,
    "ownership.mjs": 0,
  });
  for (const file of MODULE) assert.equal(count(source(file), /(?<![\w.])fetch\s*\(/gu), 0, file);
  // api.mjs only defaults the fetcher and hands it to the choke point; the rest never name it.
  assert.equal(count(source("api.mjs"), /\bfetcher\b/gu), 2);
  assert.match(
    source("api.mjs"),
    /stageRequests\(\{ accountId, token, owned, fetcher, signal \}\)/u,
  );
  for (const file of ["registry.mjs", "ownership.mjs"])
    assert.equal(count(source(file), /\bfetch(?:er)?\b|https?:\/\//gu), 0, file);
  assert.equal(count(source("api.mjs"), /https?:\/\//gu), 0);
});

// What each export of the module is. An export added without a line here fails the next test.
const EXPORTS = {
  "api.mjs": {
    stageCloudflare: "the stage API, every key of which is covered below",
    isCloudflareApiError: "a predicate over errors; sends nothing",
    WORKER_KINDS: "a constant",
  },
  "request.mjs": {
    stageRequests: "the choke point, every kind and operation of which is covered below",
    KINDS: "the declared kinds and operations",
    REGISTRY: "a constant",
    SEGMENT: "a constant",
    fail: "builds an error; sends nothing",
    isCloudflareApiError: "a predicate over errors; sends nothing",
  },
  "registry.mjs": {
    registryOperations: "holds only a send; covered through images and removeImage below",
  },
};
test("every export of the module is accounted for", () => {
  for (const [file, module] of [
    ["api.mjs", apiModule],
    ["request.mjs", requestModule],
    ["registry.mjs", registryModule],
  ])
    assert.deepEqual(Object.keys(module).sort(), Object.keys(EXPORTS[file]).sort(), file);
});

/** Names a caller could hand in for `prefix`'s stage that are not its own resource. */
const hostileNames = (prefix) => [
  "..",
  ".",
  "",
  `../basalt-production-poolworker`,
  `${prefix}-gateway/../basalt-production-poolworker`,
  `${prefix}-gateway/..`,
  `${prefix}-gateway/./settings`,
  `${prefix}-gateway%2f..%2fbasalt-production-poolworker`,
  `${prefix}-gateway%2F%2E%2E%2Fbasalt-production-poolworker`,
  `${prefix}-gateway%2e%2e`,
  `${prefix}-gateway%5c..%5cbasalt-production-poolworker`,
  `${prefix}-gateway\\..\\basalt-production-poolworker`,
  `${prefix}-gateway%252f..`,
  `/accounts/${accountId}/workers/scripts/basalt-production-poolworker`,
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/basalt-production-poolworker`,
  `//registry.cloudflare.com/v2/${accountId}/basalt-poolcontainer-production`,
  `${prefix}-gateway?force=true`,
  `${prefix}-gateway#settings`,
  `${prefix}-gateway settings`,
  `${prefix}-gateway\n`,
  `${prefix}-gate\tway`,
  prefix,
  ...lookAlikes(prefix).flatMap((other) => [`${other}-gateway`, `${other}-pool`]),
  `${prefix.slice(0, -1)}-gateway`,
  ...productionNames,
];
const hostileValues = [undefined, null, 7, {}, [], ["x"], { toString: () => "x" }];

/** A stage of `prefix` over a fresh shared account, its listed rows, and a second stage of it. */
async function stage(prefix) {
  const fake = sharedAccount(prefix);
  const reach = stageReach(fake, prefix);
  const options = { accountId, token: "t", owned: stageOwnership(prefix), fetcher: fake.fetcher };
  const send = stageRequests({ ...options, signal: () => undefined });
  const api = stageCloudflare({ accountId, token: "t", prefix, fetcher: fake.fetcher });
  const listed = {};
  for (const kind of ["applications", "namespaces", "scripts", "drives", "certificates", "images"])
    listed[kind] = await send({ kind, operation: "list" });
  const elsewhere = await stageRequests({ ...options, signal: () => undefined })({
    kind: "applications",
    operation: "list",
  });
  return { fake, reach, send, api, listed, elsewhere };
}
const ownRow = (listed, kind) =>
  listed[kind].find((row) => /^[A-Za-z0-9_-]+$/u.test(kind === "images" ? row.name : row.id));

/**
 * Rows a caller could hand in for `kind`: forged, copied, of another kind, listed by another stage,
 * listed with an id no URL may hold, and a listed row with a field changed (restored afterwards).
 */
function hostileRows({ listed, elsewhere }, kind) {
  const own = ownRow(listed, kind);
  const field = kind === "images" ? "name" : "id";
  const rows = [
    { id: "prod-app", name: "basalt-production-poolcontainer" },
    { id: "prod-app", name: own?.name ?? "x" },
    { ...own },
    Object.create(own ?? null),
    ...Object.entries(listed)
      .filter(([other]) => other !== kind)
      .map(([other]) => ownRow(listed, other)),
    ...elsewhere,
    ...listed[kind].filter((row) => row !== own),
  ].map((row) => ({ row }));
  for (const value of [
    "prod-app",
    "basalt-production-poolworker",
    "../prod-app",
    "own%2f..",
    `${own?.[field]}?x`,
  ])
    rows.push({ row: own, change: { [field]: value } });
  if (kind !== "images" && own && "name" in own)
    rows.push({ row: own, change: { name: "basalt-production-poolcontainer" } });
  if (kind === "namespaces")
    rows.push({ row: own, change: { script: "basalt-production-poolworker" } });
  return rows;
}
async function refusedWith(row, change, attempt, label) {
  const saved = change && Object.fromEntries(Object.keys(change).map((key) => [key, row[key]]));
  if (change) Object.assign(row, change);
  try {
    await assert.rejects(attempt(), /^Error: Refused/u, label);
  } finally {
    if (change) Object.assign(row, saved);
  }
}

/** What a legitimate request of each declared kind and operation is, so the matrix also sends some. */
const LEGIT = {
  "applications.list": () => ({}),
  "applications.read": (ctx) => ({ target: ownRow(ctx.listed, "applications") }),
  "applications.patch": (ctx) => ({
    target: ownRow(ctx.listed, "applications"),
    body: { max_instances: 1 },
  }),
  "applications.rollout": (ctx) => ({
    target: ownRow(ctx.listed, "applications"),
    body: { description: "x" },
  }),
  "applications.delete": (ctx) => ({ target: ownRow(ctx.listed, "applications") }),
  "namespaces.list": () => ({}),
  "namespaces.delete": (ctx) => ({ target: ownRow(ctx.listed, "namespaces") }),
  "scripts.list": () => ({}),
  "scripts.settings": (ctx) => ({ target: ctx.prefix + "-gateway" }),
  "scripts.delete": (ctx) => ({ target: ownRow(ctx.listed, "scripts") }),
  "drives.list": () => ({}),
  "drives.delete": (ctx) => ({ target: ownRow(ctx.listed, "drives") }),
  "certificates.list": () => ({}),
  "certificates.delete": (ctx) => ({ target: ownRow(ctx.listed, "certificates") }),
  "images.list": () => ({}),
  "images.tags": (ctx) => ({ target: ownRow(ctx.listed, "images") }),
  "images.manifest": (ctx) => ({ target: ownRow(ctx.listed, "images"), reference: "h1" }),
  "images.deleteManifest": (ctx) => ({
    target: ownRow(ctx.listed, "images"),
    reference: ctx.digest,
  }),
  "account.subdomain": () => ({}),
  "account.imageReferences": () => ({}),
  "account.credentials": () => ({ access: "pull" }),
};
const pairs = Object.entries(KINDS).flatMap(([kind, spec]) =>
  spec.operations.map((operation) => [kind, operation]),
);
const targeted = (kind, operation) =>
  !["list", "subdomain", "imageReferences", "credentials"].includes(operation);

test("every declared kind and operation has a legitimate case", () => {
  assert.deepEqual(
    pairs.map(([kind, operation]) => `${kind}.${operation}`).sort(),
    Object.keys(LEGIT).sort(),
  );
});

for (const prefix of STAGE_PREFIXES)
  test(`${prefix}: the choke point sends nothing outside the stage for any kind and operation`, async () => {
    for (const [kind, operation] of pairs) {
      const ctx = { prefix, ...(await stage(prefix)) };
      const { send } = ctx;
      const base = { kind, operation };
      const label = (what) => `${kind}.${operation}: ${what}`;
      const legit = LEGIT[`${kind}.${operation}`];
      // Ahead of the matrix the stage reads its image's tags and index, as a delete does.
      const image = ownRow(ctx.listed, "images");
      await send({ kind: "images", operation: "tags", target: image });
      ctx.digest = (
        await send({ kind: "images", operation: "manifest", target: image, reference: "h1" })
      ).digest;
      const fields = (extra) => {
        const request = { ...base, ...legit(ctx), ...extra };
        for (const [key, value] of Object.entries(extra))
          if (value === undefined) delete request[key];
        return request;
      };
      for (const extra of [
        { path: "/../basalt-production-poolworker" },
        {
          url: "https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/basalt-production-poolworker",
        },
        { query: "?force=true" },
        { id: "prod-app" },
        { name: "basalt-production-poolworker" },
        ...(operation === "credentials"
          ? [{ access: "admin" }, { access: ["pull", "push", "delete"] }, { access: undefined }]
          : [{ access: "push" }]),
        ...(["patch", "rollout"].includes(operation) ? [] : [{ body: {} }]),
        ...(["manifest", "deleteManifest"].includes(operation) ? [] : [{ reference: "h1" }]),
        ...(targeted(kind, operation)
          ? []
          : [{ target: ownRow(ctx.listed, "applications") }, { target: `${prefix}-gateway` }]),
      ])
        await assert.rejects(
          send(fields(extra)),
          /^Error: Refused/u,
          label(JSON.stringify(Object.keys(extra))),
        );
      for (const other of [
        "__proto__",
        "constructor",
        "toString",
        "hasOwnProperty",
        "workers/scripts",
        "../account",
        undefined,
      ])
        await assert.rejects(
          send({ ...fields({}), kind: other }),
          /^Error: Refused/u,
          label(`kind ${other}`),
        );
      const foreign = pairs.filter(([k, op]) => k !== kind && !KINDS[kind].operations.includes(op));
      for (const op of new Set([
        ...foreign.map(([, op]) => op),
        "toString",
        "__proto__",
        "GET",
        undefined,
      ]))
        await assert.rejects(
          send({ ...fields({}), operation: op }),
          /^Error: Refused/u,
          label(`operation ${op}`),
        );
      for (const request of [null, undefined, "applications", 7])
        await assert.rejects(send(request), /^Error: Refused/u, label(String(request)));
      if (targeted(kind, operation)) {
        for (const name of [...hostileNames(prefix), ...hostileValues])
          await assert.rejects(
            send(fields({ target: name })),
            /^Error: Refused/u,
            label(`target ${String(name)}`),
          );
        for (const { row, change } of hostileRows(ctx, kind))
          await refusedWith(
            row,
            change,
            () => send(fields({ target: row })),
            label(`row ${JSON.stringify(change ?? row)}`),
          );
      }
      if (["manifest", "deleteManifest"].includes(operation))
        for (const reference of [
          "p1",
          "o1",
          "x1",
          "n1",
          "../basalt-poolcontainer-production/manifests/p1",
          "h1/../../p1",
          "%2e%2e",
          "h1?x",
          "h1#x",
          " h1",
          ".",
          "..",
          `sha256:${"A".repeat(64)}`,
          `sha256:${"c".repeat(64)}`,
          ...(operation === "deleteManifest" ? ["h1"] : []),
          `https://registry.cloudflare.com/v2/${accountId}/basalt-poolcontainer-production/manifests/p1`,
          ...hostileValues,
        ])
          await assert.rejects(
            send(fields({ reference })),
            /^Error: Refused/u,
            label(`reference ${String(reference)}`),
          );
      // The legitimate request is sent, and goes only where the stage may go.
      const before = ctx.fake.calls.length;
      await send(fields({})).catch((error) =>
        assert.doesNotMatch(error.message, /^Refused/u, label("legit")),
      );
      assert.ok(ctx.fake.calls.length > before, label("the legitimate request was sent"));
      assert.deepEqual(outsideCalls(ctx.fake, prefix, ctx.reach), [], label("reach"));
      assert.ok(ctx.fake.live.applications.some((row) => row.id === "prod-app"));
      assert.deepEqual(ctx.fake.live.tags[`${accountId}/basalt-poolcontainer-production`], ["p1"]);
    }
  });

/** How each key of the stage API is called with hostile input, and with legitimate input. */
const kinds = [...Object.keys(KINDS), "workers/scripts", "__proto__", undefined];
const OPERATIONS = {
  inventory: {
    hostile: (ctx) =>
      [
        ["../x"],
        ["account"],
        ["workers/scripts"],
        ["__proto__"],
        [undefined],
        [["applications"]],
        "applications",
        {},
      ].map((kinds) => () => ctx.api.inventory(kinds)),
    legit: (ctx) =>
      ctx.api.inventory([
        "applications",
        "namespaces",
        "scripts",
        "drives",
        "certificates",
        "images",
      ]),
  },
  read: {
    hostile: (ctx) => targets(ctx, (kind, target) => ctx.api.read(kind, target)),
    legit: (ctx) => ctx.api.read("applications", ctx.rows.applications),
  },
  settings: {
    hostile: (ctx) => targets(ctx, (kind, target) => ctx.api.settings(target), ["scripts"]),
    legit: (ctx) => ctx.api.settings(`${ctx.prefix}-gateway`),
  },
  patch: {
    hostile: (ctx) =>
      targets(ctx, (kind, target) => ctx.api.patch(kind, target, { max_instances: 1 })),
    legit: (ctx) => ctx.api.patch("applications", ctx.rows.applications, { max_instances: 1 }),
  },
  rollout: {
    hostile: (ctx) =>
      targets(ctx, (kind, target) => ctx.api.rollout(kind, target, { description: "x" })),
    legit: (ctx) => ctx.api.rollout("applications", ctx.rows.applications, { description: "x" }),
  },
  remove: {
    hostile: (ctx) => targets(ctx, (kind, target) => ctx.api.remove(kind, target)),
    legit: (ctx) => ctx.api.remove("applications", ctx.rows.applications),
  },
  images: { hostile: () => [], legit: (ctx) => ctx.api.images() },
  removeImage: {
    hostile: (ctx) => targets(ctx, (kind, target) => ctx.api.removeImage(target), ["images"]),
    legit: (ctx) => ctx.api.removeImage(ctx.rows.images),
  },
  subdomain: { hostile: () => [], legit: (ctx) => ctx.api.subdomain() },
  imageReferences: { hostile: () => [], legit: (ctx) => ctx.api.imageReferences() },
};
const NOT_OPERATIONS = {
  prefix: "the stage's prefix",
  owned: "the ownership predicate; sends nothing",
};

/** Each hostile name, value and row, for each kind `of` names. */
function targets(ctx, call, of = kinds) {
  const attempts = [];
  for (const kind of of) {
    for (const target of [...hostileNames(ctx.prefix), ...hostileValues])
      attempts.push(() => call(kind, target));
    if (!Object.hasOwn(ctx.apiListed, kind)) continue;
    for (const { row, change } of hostileRows(
      { listed: ctx.apiListed, elsewhere: ctx.elsewhere },
      kind,
    ))
      attempts.push(Object.assign(() => call(kind, row), { row, change }));
  }
  return attempts;
}

test("every key of the stage API has a hostile and a legitimate case", async () => {
  const { api } = await stage(STAGE_PREFIXES[0]);
  assert.deepEqual(
    Object.keys(api).sort(),
    [...Object.keys(OPERATIONS), ...Object.keys(NOT_OPERATIONS)].sort(),
  );
  for (const key of Object.keys(OPERATIONS)) assert.equal(typeof api[key], "function", key);
});

for (const prefix of STAGE_PREFIXES)
  test(`${prefix}: no stage API operation sends anything outside the stage`, async () => {
    for (const [key, { hostile, legit }] of Object.entries(OPERATIONS)) {
      const ctx = { prefix, ...(await stage(prefix)) };
      const found = await ctx.api.inventory([
        "applications",
        "namespaces",
        "scripts",
        "drives",
        "certificates",
      ]);
      ctx.apiListed = { ...found, images: await ctx.api.images() };
      ctx.rows = Object.fromEntries(
        Object.keys(ctx.apiListed).map((kind) => [kind, ownRow(ctx.apiListed, kind)]),
      );
      for (const attempt of hostile(ctx))
        await refusedWith(
          attempt.row,
          attempt.change,
          attempt,
          `${key}: ${String(attempt.change ? JSON.stringify(attempt.change) : "")}`,
        );
      const before = ctx.fake.calls.length;
      // The fake account answers what it records; a rollout it has no recorded answer for is
      // still sent, and only where it was sent is judged.
      const result = await legit(ctx).catch((error) =>
        assert.doesNotMatch(error.message, /^Refused/u, `${key} legit`),
      );
      assert.ok(ctx.fake.calls.length > before, `${key} sent its legitimate request`);
      assert.deepEqual(outsideCalls(ctx.fake, prefix, ctx.reach), [], key);
      // Account-wide reads return only the stage's own rows, or no row at all.
      if (key === "inventory" || key === "images")
        for (const rows of key === "images" ? [result] : Object.values(result))
          for (const row of rows) {
            const name = row.script ?? row.name ?? row.id;
            assert.ok(name.startsWith(`${prefix}-`), `${key} returned ${name}`);
          }
      if (key === "imageReferences") {
        assert.ok(result.every((reference) => typeof reference === "string"));
        for (const reference of result)
          await assert.rejects(ctx.api.remove("applications", reference), /^Error: Refused/u);
      }
      assert.ok(ctx.fake.live.applications.some((row) => row.id === "prod-app"));
      assert.deepEqual(ctx.fake.live.tags[`${accountId}/basalt-poolcontainer-production`], ["p1"]);
    }
  });
