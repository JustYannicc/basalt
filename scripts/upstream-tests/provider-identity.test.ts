import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Crypto, Effect } from "effect";

const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
const load = (path: string) => import(pathToFileURL(resolve(upstream, path)).href);
const implementation = "packages/sdk/src/implementation/";
const { identifyProvider } = await load(`${implementation}provider.ts`);
const { chooseProviderIds, previousRequirements } = await load(`${implementation}apps.ts`);

type Definition = { name: string; auth: Record<string, Record<string, unknown>>; hosts?: string[] };
type Identified = { identity: string; legacy: string };

const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) =>
    Effect.succeed(new Uint8Array(createHash("sha256").update(data).digest())),
});
const identify = (definition: Definition): Promise<Identified> =>
  Effect.runPromise(identifyProvider(definition, crypto));

const fields = (token: Record<string, unknown> = { type: "string" }) => ({
  type: "object",
  properties: { token },
  required: ["token"],
});
const slack = (options: { label?: string; token?: Record<string, unknown> } = {}): Definition => ({
  name: "Slack",
  auth: {
    token: { type: "secrets", label: options.label ?? "Bot or user token (xoxb-/xoxp-)", fields: fields(options.token) },
    oauth: {
      type: "oauth2",
      authorizationUrl: "https://slack.com/oauth/v2/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.access",
      scopes: ["chat:write"],
      response: { type: "object", properties: { access_token: { type: "string" } } },
    },
  },
});

test("rewording a label or a field's title and description keeps the identity", async () => {
  const base = await identify(slack());
  assert.equal((await identify(slack({ label: "Paste a token" }))).identity, base.identity);
  const described = await identify(
    slack({ token: { type: "string", title: "Token", description: "From your Slack app settings" } }),
  );
  assert.equal(described.identity, base.identity);
  // The ID earlier versions derived still covers the label, so stored rows keep theirs.
  assert.notEqual((await identify(slack({ label: "Paste a token" }))).legacy, base.legacy);
  // Hosts were never part of it.
  assert.equal((await identify({ ...slack(), hosts: ["slack.com"] })).identity, base.identity);
});

test("a real credential change makes a new identity", async () => {
  const base = (await identify(slack())).identity;
  const changed = async (definition: Definition) =>
    assert.notEqual((await identify(definition)).identity, base);
  await changed(slack({ token: { type: "number" } }));
  await changed(slack({ token: { type: "string", minLength: 10 } }));
  const { oauth: _oauth, ...tokenOnly } = slack().auth;
  await changed({ ...slack(), auth: tokenOnly });
  const moved = slack();
  moved.auth.oauth = { ...moved.auth.oauth, tokenUrl: "https://slack.example/api/oauth.v2.access" };
  await changed(moved);
  await changed({ ...slack(), name: "Slack (staging)" });
});

test("field text goes at every nested schema position", async () => {
  const nested = (text: Record<string, string>) =>
    identify({
      name: "Nested",
      auth: {
        key: {
          type: "secrets",
          label: "Key",
          fields: {
            type: "object",
            properties: {
              tags: { type: "array", items: { type: "string", ...text } },
              region: { anyOf: [{ type: "string", ...text }, { type: "null" }] },
              site: { $ref: "#/$defs/site" },
            },
            dependencies: { region: ["site"] },
            $defs: { site: { type: "string", format: "uri", ...text } },
          },
        },
      },
    });
  const plain = (await nested({})).identity;
  assert.equal((await nested({ title: "Tags", description: "Shown in the form" })).identity, plain);
});

test("a field named title or description is part of the identity", async () => {
  const named = (properties: Record<string, unknown>): Definition => ({
    name: "Notes",
    auth: { key: { type: "secrets", label: "Key", fields: { type: "object", properties } } },
  });
  const both = await identify(named({ title: { type: "string" }, description: { type: "string" } }));
  const one = await identify(named({ title: { type: "string" } }));
  const other = await identify(named({ heading: { type: "string" } }));
  assert.notEqual(both.identity, one.identity);
  assert.notEqual(one.identity, other.identity);
  // So is a `$defs` entry named `title`: the map's names are not schema keywords.
  const defs = (name: string) =>
    identify({
      name: "Notes",
      auth: {
        key: {
          type: "secrets",
          label: "Key",
          fields: {
            type: "object",
            properties: { note: { $ref: `#/$defs/${name}` } },
            $defs: { [name]: { type: "string" } },
          },
        },
      },
    });
  assert.notEqual((await defs("title")).identity, (await defs("heading")).identity);
});

test("a deploy keeps the provider IDs accounts were saved under", async () => {
  const reworded = { ...(await identify(slack({ label: "Paste a token" }))) };
  const stored = (await identify(slack())).legacy;
  const choose = (
    entries: { slot: string; provider: Identified }[],
    previous: Record<string, { provider: string; definition: Definition }> | undefined,
    rows: string[] = [],
  ) => {
    const asked: string[][] = [];
    const db = {
      findMany: (_table: string, options: { where: (b: unknown) => unknown }) => {
        const condition = (field: string, op: string, value: string[]) => ({ field, op, value });
        const where = options.where(condition) as { value: string[] };
        asked.push(where.value);
        return Effect.succeed(rows.filter((id) => where.value.includes(id)).map((id) => ({ id })));
      },
    };
    return Effect.runPromise(chooseProviderIds(db, crypto, entries, previous)).then((chosen) => ({
      ids: (chosen as { provider: { id: string } }[]).map((entry) => entry.provider.id),
      asked,
    }));
  };
  const entry = [{ slot: "slack", provider: reworded }];
  // The active version's ID wins over a row stored under this exact definition's earlier ID.
  const both = await choose(
    [{ slot: "slack", provider: await identify(slack()) }],
    { slack: { provider: "prv_active", definition: slack({ label: "Paste a token" }) } },
    [stored],
  );
  assert.deepEqual(both, { ids: ["prv_active"], asked: [] });
  // The active version's ID for the same identity, whatever its wording, even under another name.
  const kept = await choose(entry, { workspace: { provider: stored, definition: slack() } });
  assert.deepEqual(kept, { ids: [stored], asked: [] });
  // Without one, the row stored under this exact definition's earlier ID.
  const exact = await identify(slack());
  const reused = await choose([{ slot: "slack", provider: exact }], undefined, [exact.legacy]);
  assert.deepEqual(reused.ids, [exact.legacy]);
  // Otherwise the identity.
  assert.deepEqual((await choose(entry, undefined)).ids, [reworded.identity]);
  // A real change never keeps the previous ID.
  const retyped = await identify(slack({ token: { type: "number" } }));
  const fresh = await choose([{ slot: "slack", provider: retyped }], {
    slack: { provider: stored, definition: slack() },
  });
  assert.deepEqual(fresh.ids, [retyped.identity]);
});

test("a build for an app keeps the IDs of that app's active version", async () => {
  const definition = slack();
  const rows: Record<string, Record<string, unknown> | null> = {
    apps: {
      id: "app_example",
      slug: "example",
      code: "code_example",
      repository: null,
      owner: "organization:example",
      name: "example",
      activeDeployment: "dpl_example",
      copiedFrom: null,
      createdAt: new Date(0),
      deploySequence: 1,
      activatedSequence: 1,
    },
    deployments: {
      requirements: {
        accounts: {
          slack: { scope: "user", provider: "prv_stored", definition, cardinality: "one" },
        },
      },
    },
  };
  const db = (present: boolean) => ({
    findFirst: (table: string) => Effect.succeed(present ? (rows[table] ?? null) : null),
  });
  const input = { app: "app_example", owner: "organization:example" };
  const previous = (await Effect.runPromise(previousRequirements(db(true), input))) as
    Record<string, { provider: string }>;
  assert.equal(previous.slack!.provider, "prv_stored");
  // Those requirements are what keeps the ID through a reword.
  const reworded = await identify(slack({ label: "Paste a token" }));
  const chosen = await Effect.runPromise(
    chooseProviderIds({ findMany: () => Effect.succeed([]) }, crypto, [{ slot: "slack", provider: reworded }], previous),
  );
  assert.equal((chosen as { provider: { id: string } }[])[0]!.provider.id, "prv_stored");
  // An app that is gone keeps none, as a new app's deploy would.
  assert.equal(await Effect.runPromise(previousRequirements(db(false), input)), undefined);
});

test("deploys and catalog checks choose IDs the same way", () => {
  const apps = readFileSync(resolve(upstream, `${implementation}apps.ts`), "utf8");
  assert.match(apps, /const entries = yield\* chooseProviderIds\(db, crypto, identified, options\.previous\)/);
  assert.match(apps, /previous === undefined \? \{\} : \{ previous: previous\.accounts \}/);
  assert.match(apps, /yield\* previousRequirements\(db, \{ app: input\.app, owner: input\.owner \}\)/);
  assert.match(apps, /create: \{ id: provider\.id, definition \}/);
  const catalog = readFileSync(
    resolve(upstream, "apps/hosted/server/src/implementation/catalog-app-defaults.ts"),
    "utf8",
  );
  assert.match(catalog, /executor\.apps\.build\(\{ owner, name: app\.name, files, app: app\.id \}\)/);
});
