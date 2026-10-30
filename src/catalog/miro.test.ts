import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleCatalog } from "./worker.ts";
import { miroSource } from "./miro.ts";

const requestedScopes = [
  "boards:read",
  "boards:write",
  "identity:read",
  "identity:write",
  "microphone:listen",
  "screen:record",
  "team:read",
  "team:write",
  "webcam:record",
  "auditlogs:read",
  "sessions:delete",
];

test("Miro serves the full carried REST source without publisher access", async () => {
  const response = await handleCatalog(new Request("https://catalog.example.test/catalog/apps/miro.json"),
    async () => { throw new Error("Carried Miro source must not require its publisher"); });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), miroSource);
  const head = await handleCatalog(new Request("https://catalog.example.test/catalog/apps/miro.json", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("Miro catalog offers personal OAuth first and keeps its access-token fallback", async () => {
  const official = { version: 1, apps: [{ id: "miro", package: "@executor.sh/miro", name: "Miro",
    description: "Miro boards and everything on them", auth: [{ method: "token", kind: "secrets" }],
    icons: [{ src: "icons/miro.svg" }], source: "apps/miro.json" }] };
  const response = await handleCatalog(new Request("https://catalog.example.test/catalog/index.json"),
    async () => Response.json(official));
  assert.equal(response.status, 200);
  const feed = await response.json() as { apps: { id: string; auth: { method: string }[]; description: string;
    connectionNotices?: unknown }[] };
  const miro = feed.apps.find(app => app.id === "miro")!;
  assert.deepEqual(miro.auth.map(method => method.method), ["oauth", "token"]);
  assert.match(miro.description, /team and organization administration/);
  assert.match(miro.description, /Enterprise and Company Admin/);
  assert.equal(miro.connectionNotices, undefined);
});

test("Miro carry preserves the full OpenAPI package and aligns the app scopes with its provenance", () => {
  const load = (name: string) => readFileSync(new URL(name, import.meta.url));
  const provenance = JSON.parse(load("./miro.provenance.json").toString());
  const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
  const publishedBytes = load("./miro.published.json");
  const carriedBytes = load("./miro.json");
  const patchBytes = load("./miro.patch");
  assert.equal(digest(publishedBytes), provenance.publishedSha256);
  assert.equal(digest(carriedBytes), provenance.carriedSha256);
  assert.equal(digest(patchBytes), provenance.patchSha256);
  assert.equal(provenance.scopeSource, "https://developers.miro.com/reference/scopes");
  assert.deepEqual(provenance.requestedScopes, requestedScopes);

  const published = JSON.parse(publishedBytes.toString());
  const carried = JSON.parse(carriedBytes.toString());
  const appSource = carried.files.find((file: { path: string }) => file.path === "index.ts")!.content;
  const openapi = carried.files.find((file: { path: string }) => file.path === "openapi.ts")!.content;
  const readme = carried.files.find((file: { path: string }) => file.path === "README.md")!.content;
  const sourceScopes = [...appSource.matchAll(/^\s*"([^"]+)"[,]?$/gm)].map(match => match[1]);
  for (const scope of requestedScopes) assert.ok(appSource.includes(`"${scope}"`), `App omitted ${scope}`);
  assert.doesNotMatch(appSource, /organizations:read|organizations:teams:/);
  assert.ok(sourceScopes.includes("boards:read") && sourceScopes.includes("sessions:delete"));
  assert.match(appSource, /tool\.kind === "mutation" \? always\(\) : undefined/);
  assert.match(openapi, /organization|team/i);
  assert.match(openapi, /SCIM/);
  assert.match(readme, /does not use the Web SDK/);
  assert.match(readme, /Company Admin/);
  assert.match(readme, /Enterprise-only/i);

  const directory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "basalt-miro-carry-"));
  try {
    for (const file of published.files) writeFileSync(join(directory, file.path), file.content);
    execFileSync("git", ["apply", new URL("./miro.patch", import.meta.url).pathname], { cwd: directory });
    for (const file of carried.files)
      assert.equal(readFileSync(join(directory, file.path), "utf8"), file.content, `Carry patch missed ${file.path}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const manifest = JSON.parse(carried.files.find((file: { path: string }) => file.path === "package.json")!.content);
  assert.equal(manifest.dependencies.apps, provenance.appsVersion);
  assert.equal(manifest.dependencies.apps, "0.0.1-beta.104-basalt.1");
  assert.deepEqual(published.files.map((file: { path: string }) => file.path), carried.files.map((file: { path: string }) => file.path));
});
