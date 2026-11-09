import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { handleCatalog } from "./worker.ts";
import { onServedFramework } from "./framework.ts";
import { planetscaleSource } from "./planetscale.ts";

const file = (path: string) =>
  planetscaleSource.files.find((entry) => entry.path === path)?.content;

/** The carried app's generated scope table, loaded as the module the app imports. */
const scopeTable = async () => {
  const directory = mkdtempSync(join(tmpdir(), "planetscale-scopes-"));
  try {
    const path = join(directory, "scopes.ts");
    writeFileSync(path, file("scopes.ts")!);
    return (await import(pathToFileURL(path).href)) as {
      scopeAliases: Readonly<Record<string, string>>;
      serviceTokenOnly: ReadonlySet<string>;
      operationNames: readonly string[];
      operationNamespaces: readonly string[];
      operationScopes: Readonly<Record<string, readonly string[]>>;
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("PlanetScale source remains available when its publisher is unavailable", async () => {
  const request = new Request("https://catalog.example.test/catalog/apps/planetscale.json");
  const response = await handleCatalog(request, async () => {
    throw new Error("Publisher unavailable");
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    JSON.parse(onServedFramework(JSON.stringify(planetscaleSource))),
  );
});

test("PlanetScale guides bind exact methods and declare the service-token section", async () => {
  const methods = [
    { method: "token", kind: "secrets", label: "Service token" },
    { method: "oauth2", kind: "oauth2", label: "OAuth 2.0" },
  ];
  const entry = (id: string) => ({
    id,
    package: `@executor.sh/${id}`,
    name: id,
    description: "Fixture service.",
    auth: methods,
    icons: [],
    source: `apps/${id}.json`,
  });
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/index.json"),
    async () =>
      Response.json({ version: 1, apps: [entry("planetscale"), entry("example-vendor")] }),
  );
  const feed = await response.json();
  const planetscale = feed.apps.find((item: { id: string }) => item.id === "planetscale");
  assert.deepEqual(planetscale.auth, [
    { method: "signIn", kind: "oauth2", label: "Sign in with PlanetScale" },
    methods[0],
    { method: "oauth2", kind: "oauth2", label: "Existing PlanetScale OAuth" },
  ]);
  assert.deepEqual(
    planetscale.connectionGuidance.map((guide: { requirement: string; method: string }) => [
      guide.requirement,
      guide.method,
    ]),
    [
      ["planetscale", "oauth2"],
      ["planetscaleSignIn", "signIn"],
      ["planetscale", "token"],
    ],
  );
  assert.equal(
    planetscale.connectionGuidance.find(
      (guide: { requirement: string; method: string }) =>
        guide.requirement === "planetscale" && guide.method === "token",
    ).credentials.fields.token.label,
    "Service token",
  );
  assert.deepEqual(
    planetscale.toolSections.map(
      ({ path, requirement, method, actionLabel }: Record<string, string>) => ({
        path,
        requirement,
        method,
        actionLabel,
      }),
    ),
    [
      {
        path: "serviceToken",
        requirement: "planetscale",
        method: "token",
        actionLabel: "Add service token",
      },
    ],
  );
  // A hosted decision gives no deferral when its client is configured; the review still classifies it.
  const unrelated = feed.apps.find((item: { id: string }) => item.id === "example-vendor");
  assert.deepEqual(unrelated.auth, methods);
  assert.equal(unrelated.connectionGuidance, undefined);
  assert.equal(unrelated.toolSections, undefined);
});

test("PlanetScale refuses a publisher package change", async () => {
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/index.json"),
    async () =>
      Response.json({
        version: 1,
        apps: [
          {
            id: "planetscale",
            package: "@other/planetscale",
            name: "PlanetScale",
            description: "Fixture.",
            auth: [],
            icons: [],
            source: "apps/planetscale.json",
          },
        ],
      }),
  );
  assert.equal(response.status, 502);
});

test("PlanetScale preserves the legacy provider and scopes the new provider independently", () => {
  const bytes = (extension: string) =>
    readFileSync(new URL(`./planetscale.${extension}`, import.meta.url));
  const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  const provenance = JSON.parse(bytes("provenance.json").toString());
  assert.equal(digest(bytes("published.json")), provenance.publishedSha256);
  assert.equal(digest(bytes("json")), provenance.carriedSha256);
  assert.equal(digest(bytes("patch")), provenance.patchSha256);
  const original = JSON.parse(bytes("published.json").toString());
  const before = original.files.find(
    (entry: { path: string }) => entry.path === "index.ts",
  ).content;
  const after = file("index.ts")!;
  const providerBlock = (content: string, marker: string) => {
    const start = content.indexOf(marker);
    assert.notEqual(start, -1, marker);
    const end = content.indexOf("\n});", start);
    assert.notEqual(end, -1, marker);
    return content.slice(start, end + 4);
  };
  assert.equal(
    providerBlock(after, "const planetscale = defineProvider({"),
    providerBlock(before, "const planetscale = defineProvider({"),
    "the old provider declaration remains byte-for-byte stable so its account and grant identity stays stable",
  );
  assert.match(after, /const planetscaleSignIn = defineProvider\(/);
  assert.match(after, /signIn: oauth2\(\{\n\s+discover: "https:\/\/api\.planetscale\.com",/);
  assert.match(after, /planetscale: planetscale\.many\(\)/);
  assert.match(after, /planetscaleSignIn: planetscaleSignIn\.many\(\)/);
  for (const path of ["openapi.ts", "icon.ts"])
    assert.equal(
      file(path),
      original.files.find((entry: { path: string }) => entry.path === path)?.content,
      path,
    );
});

test("PlanetScale scope table covers every operation exactly once", async () => {
  const table = await scopeTable();
  const oauth = Object.keys(table.operationScopes);
  assert.equal(oauth.length, 257, "Operations PlanetScale accepts the hosted scopes for");
  assert.equal(table.serviceTokenOnly.size, 34, "Operations only a service token can call");
  assert.equal(oauth.filter((name) => table.serviceTokenOnly.has(name)).length, 0);
  assert.equal(table.operationNames.length, 291);
  assert.deepEqual(
    [...table.operationNames].sort(),
    [...new Set([...oauth, ...table.serviceTokenOnly])].sort(),
  );
  assert.ok(table.operationNames.every((name) => name.split(".").length === 2));
  assert.deepEqual(
    [...table.operationNamespaces],
    [...new Set(table.operationNames.map((name) => name.split(".")[0]))].sort(),
  );
  assert.ok(!table.operationNamespaces.includes("serviceToken"));
  const requested = new Set(
    hosted.flatMap((scope) => {
      const alias = Object.entries(table.scopeAliases).find(([s, l]) => s === scope || l === scope);
      return alias === undefined ? [scope] : alias;
    }),
  );
  for (const [name, accepted] of Object.entries(table.operationScopes))
    assert.ok(
      accepted.some((scope) => requested.has(scope)),
      `${name} needs a requested scope`,
    );
  // Every requested scope earns its place by unlocking at least one operation.
  for (const scope of hosted) {
    const forms = Object.entries(table.scopeAliases).find(
      ([s, l]) => s === scope || l === scope,
    ) ?? [scope];
    assert.ok(
      Object.values(table.operationScopes).some((accepted) =>
        forms.some((form) => accepted.includes(form)),
      ),
      `${scope} unlocks no operation`,
    );
  }
  for (const name of table.operationNames)
    assert.ok(oauth.includes(name) || table.serviceTokenOnly.has(name), `${name} is unknown`);

  const inventory = JSON.parse(
    readFileSync(
      new URL("../../e2e/planetscale-signin/legacy-operations.json", import.meta.url),
      "utf8",
    ),
  ) as Array<{ name: string; namespace: string }>;
  assert.equal(inventory.length, 291);
  assert.deepEqual(
    inventory.map((operation) => operation.name).sort(),
    [...table.operationNames].sort(),
  );
  for (const operation of inventory)
    assert.equal(operation.namespace, operation.name.split(".")[0]);
});
