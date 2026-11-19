import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Run with the prepared Basalt checkout. Google is never called: fetch answers the account check's
// geocoding read with a synthetic body status.
const root = process.argv[2];
assert.ok(root, "Pass the prepared Basalt checkout as the first argument");
const { googleMapsAddition } = await import(
  pathToFileURL(join(root, "src/catalog/google-maps/index.ts")).href
);
const source = googleMapsAddition("https://catalog.example.test").source;
const framework = join(root, ".upstream/packages/apps/src");
const load = (path) => import(pathToFileURL(path).href);
const directory = await mkdtemp(join(tmpdir(), "google-maps-runtime-"));
const publicExports = {
  apps: "index.ts",
  "apps/openapi": "openapi.ts",
  "apps/operations/approval": "approval.ts",
};
const rewriteImports = (content) => {
  for (const [name, file] of Object.entries(publicExports))
    content = content.replaceAll(
      JSON.stringify(name),
      JSON.stringify(pathToFileURL(join(framework, file)).href),
    );
  return content;
};
let status = "OK";
const originalFetch = globalThis.fetch;
try {
  for (const file of source.files) {
    const target = join(directory, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      file.path.endsWith(".ts") ? rewriteImports(file.content) : file.content,
    );
  }
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).pathname, "/maps/api/geocode/json");
    return Response.json({ status, results: [] });
  };
  const host = await load(join(framework, "host.ts"));
  const handler = host.createAppHandler((await load(join(directory, "index.ts"))).default);
  const request = async (command, accounts) => {
    const response = await handler(
      new Request("https://fixture.invalid", { method: "POST", body: JSON.stringify(command) }),
      host.hostContext(accounts),
    );
    return await response.json();
  };
  const requirements = await request({ operation: "requirements" }, { app: {} });
  assert.equal(requirements.ok, true, JSON.stringify(requirements));
  const account = {
    id: "acc_maps_synthetic",
    provider: requirements.value.accounts.user.googleMaps.definition,
    method: "apiKey",
    fields: { apiKey: "synthetic-maps-key" },
  };
  const check = async (next) => {
    status = next;
    const result = await request(
      { operation: "account-check", requirement: "googleMaps" },
      { app: {}, user: { googleMaps: account } },
    );
    return result.ok ? "verified" : JSON.stringify(result.error);
  };
  assert.equal(await check("OK"), "verified");
  assert.equal(await check("ZERO_RESULTS"), "verified");
  assert.match(await check("REQUEST_DENIED"), /rejected the API key \(REQUEST_DENIED\)/);
  for (const answer of ["OVER_QUERY_LIMIT", "UNKNOWN_ERROR", "INVALID_REQUEST"]) {
    const outcome = await check(answer);
    assert.doesNotMatch(outcome, /rejected/i, `${answer} must not read as a rejected key`);
    assert.match(outcome, new RegExp(`answered the account check with ${answer}`), outcome);
  }
  console.log("Google Maps account check refuses only REQUEST_DENIED PASS");
} finally {
  globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
}
