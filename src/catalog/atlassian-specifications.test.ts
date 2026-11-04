import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { handleRequest } from "../router.ts";
import { handleCatalog } from "./worker.ts";
import source from "./atlassian/source.json" with { type: "json" };
import provenance from "./atlassian/provenance.json" with { type: "json" };

const directory = mkdtempSync(join(tmpdir(), "atlassian-specification-"));
after(() => rmSync(directory, { recursive: true, force: true }));
for (const name of ["specifications.ts", "api-coverage.json", "openapi.ts"])
  writeFileSync(join(directory, name), source.files.find((file) => file.path === name)!.content);
writeFileSync(
  join(directory, "configuration.js"),
  source.files.find((file) => file.path === "configuration.ts")!.content,
);
const { specificationCache } = await import(
  pathToFileURL(join(directory, "specifications.ts")).href
);
const { optionsFor } = await import(pathToFileURL(join(directory, "openapi.ts")).href);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

for (const name of ["jira", "serviceManagement"] as const) {
  const api = provenance.capabilities.apis[name];
  const bytes = readFileSync(new URL(`../../${api.asset}`, import.meta.url));

  test(`${name} loads its actual static asset through the router without fetching the mutable vendor URL`, async () => {
    const calls: string[] = [];
    const fail = async () => {
      throw new Error("Mutable vendor or service reached");
    };
    const backing = {
      get: async (options: { load: (context: unknown) => Promise<unknown> }) =>
        options.load({
          cache: backing,
          fetch: async (input: string) => {
            calls.push(input);
            return handleRequest(new Request(input), {
              POOL_APP_SIGNING_KEY: "ab".repeat(32),
              ASSETS: {
                fetch: async (request) => {
                  assert.equal(new URL(request.url).pathname, new URL(api.url).pathname);
                  return new Response(bytes, { headers: { "Content-Type": "application/json" } });
                },
              },
              TOOLS_SERVICE: { fetch: fail },
              CATALOG_SERVICE: { fetch: fail },
              POOL_SERVICE: { fetch: fail },
            });
          },
        }),
    };
    const options = optionsFor(name);
    assert.equal(options.source.url, api.url);
    const loaded = await specificationCache(name, backing).get({
      key: ["document"],
      load: async (context: { fetch: typeof fetch }) =>
        new Uint8Array(await (await context.fetch(options.source.url)).arrayBuffer()),
    });
    assert.equal(hash(loaded), api.sha256);
    assert.deepEqual(calls, [api.url]);
    assert.notEqual(api.url, api.vendorUrl);
  });

  test(`${name} rejects changed immutable bytes before compilation`, async () => {
    const backing = {
      get: async (options: { load: (context: unknown) => Promise<unknown> }) =>
        options.load({
          cache: backing,
          fetch: async () => new Response(Buffer.concat([bytes, Buffer.from("\n")])),
        }),
    };
    await assert.rejects(
      specificationCache(name, backing).get({
        key: ["document"],
        load: (context: { fetch: typeof fetch }) => context.fetch(api.url),
      }),
      /Atlassian OpenAPI document changed/,
    );
  });

  test(`${name} retained bytes preserve the reviewed OAuth scopes and excluded operations`, () => {
    assert.equal(hash(bytes), api.sha256);
    assert.equal(api.asset, `public/catalog/openapi/atlassian/${api.sha256}.json`);
    const document = JSON.parse(bytes.toString());
    const coverage = JSON.parse(
      source.files.find((file) => file.path === "api-coverage.json")!.content,
    )[name];
    const operations = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.entries(item as Record<string, Record<string, unknown>>)
        .filter(([method]) => methods.has(method))
        .map(([method, operation]) => ({ path, method, ...operation })),
    );
    assert.equal(operations.length, api.declaredOperations);
    const excluded = new Set(
      coverage.excluded.map(
        (operation: { path: string; method: string }) => `${operation.method} ${operation.path}`,
      ),
    );
    assert.equal(operations.length - excluded.size, api.retainedOperations);
    for (const operation of coverage.excluded) {
      assert.equal(
        document.paths[operation.path][operation.method].operationId,
        operation.operationId,
      );
      const pointer = operation.path.replaceAll("~", "~0").replaceAll("/", "~1");
      assert.ok(
        optionsFor(name).patches.some(
          (patch: { path: string }) => patch.path === `/paths/${pointer}/${operation.method}`,
        ),
      );
    }
    for (const operation of operations) {
      if (excluded.has(`${operation.method} ${operation.path}`)) continue;
      const vendor = document.paths[operation.path][operation.method];
      assert.ok(
        (vendor.security ?? document.security).some((alternative: object) =>
          Object.hasOwn(alternative, "OAuth2"),
        ),
      );
      const alternatives = vendor["x-atlassian-oauth2-scopes"];
      if (alternatives === undefined) continue;
      const allowed: readonly string[] = api.scopes;
      assert.ok(
        alternatives.some(
          (alternative: { state: string; scopes: string[] }) =>
            alternative.state !== "Beta" &&
            alternative.scopes.every((scope) => allowed.includes(scope)),
        ),
        `${name}: ${operation.method} ${operation.path} adds an unreviewed scope`,
      );
    }
  });
}

test("the catalog resolves pinned specifications on its own origin without rewriting vendor APIs", async () => {
  const origin = "https://self-host.example.test";
  const response = await handleCatalog(new Request(`${origin}/catalog/apps/atlassian.json`));
  const served = await response.json();
  const coverage = JSON.parse(
    served.files.find((file: { path: string }) => file.path === "api-coverage.json").content,
  );
  for (const name of ["jira", "serviceManagement"] as const) {
    const api = provenance.capabilities.apis[name];
    assert.equal(coverage[name].url, `${origin}/catalog/openapi/atlassian/${api.sha256}.json`);
    assert.equal(coverage[name].sha256, api.sha256);
  }
  assert.equal(coverage.confluence.url, provenance.capabilities.apis.confluence.url);
  assert.equal(coverage.confluenceV2.url, provenance.capabilities.apis.confluenceV2.url);
});
