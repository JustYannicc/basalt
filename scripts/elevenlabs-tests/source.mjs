import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const byPath = (files, path) => {
  const file = files.find((item) => item.path === path);
  assert.ok(file, `Official snapshot is missing ${path}`);
  return file.content;
};

const replaceExact = (content, before, after, label) => {
  const count = content.split(before).length - 1;
  assert.equal(count, 1, `${label}: expected one source match, found ${count}`);
  return { content: content.replace(before, after), substitution: { label, from: before, to: after, occurrences: count } };
};

const recordFile = (files, path, content) => {
  const index = files.findIndex((file) => file.path === path);
  assert.notEqual(index, -1, `Official snapshot is missing ${path}`);
  files[index] = { ...files[index], content };
};

/** Read the saved public package snapshot. This helper never fetches a provider URL. */
export async function readElevenLabsSnapshot(snapshotPath) {
  const bytes = await readFile(snapshotPath);
  const snapshot = JSON.parse(bytes.toString("utf8"));
  assert.equal(snapshot.package, "@executor.sh/elevenlabs");
  assert.ok(Array.isArray(snapshot.files));
  assert.deepEqual(new Set(snapshot.files.map((file) => file.path)).size, snapshot.files.length,
    "Official package file paths must be unique");
  return { snapshot, bytes };
}

/** Adapt only loopback request origins, the selected OpenAPI fixture patch and local apps version. */
export function prepareLocalMockSource(inputFiles, appsVersion, fixture) {
  const files = inputFiles.map((file) => ({ ...file }));
  const substitutions = [];
  const replaceFile = (path, before, after, label) => {
    const replaced = replaceExact(byPath(files, path), before, after, label);
    recordFile(files, path, replaced.content);
    substitutions.push({ file: path, ...replaced.substitution });
  };

  const manifest = JSON.parse(byPath(files, "package.json"));
  assert.equal(manifest.name, "@executor.sh/elevenlabs");
  assert.equal(manifest.dependencies?.apps, "0.0.1-beta.100", "Unexpected published apps dependency");
  if (manifest.dependencies.apps !== appsVersion) {
    const from = manifest.dependencies.apps;
    manifest.dependencies.apps = appsVersion;
    recordFile(files, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
    substitutions.push({ file: "package.json", label: "local apps package version", from, to: appsVersion, occurrences: 1 });
  }

  replaceFile("index.ts", 'hosts: ["api.elevenlabs.io"]',
    `hosts: [${JSON.stringify(fixture.host)}]`, "provider host to loopback");
  replaceFile("index.ts", 'fetch("https://api.elevenlabs.io/v1/user", {',
    `fetch(${JSON.stringify(`${fixture.origin}/v1/user`)}, {`, "health URL to loopback");
  replaceFile("openapi.ts", 'source: { url: "https://api.elevenlabs.io/openapi.json" }',
    `source: { url: ${JSON.stringify(`${fixture.origin}/openapi.json`)} }`, "OpenAPI source to local fixture");
  replaceFile("openapi.ts", 'allowedOrigin: "https://api.elevenlabs.io"',
    `allowedOrigin: ${JSON.stringify(fixture.origin)}`, "allowed origin to loopback");
  replaceFile("openapi.ts", 'baseUrl: "https://api.elevenlabs.io"',
    `baseUrl: ${JSON.stringify(fixture.origin)}`, "API base URL to loopback");

  const originalPatches = JSON.parse(byPath(files, "header-patches.json"));
  const voicePatchPath = "/paths/~1v1~1voices/get/parameters";
  const voicePatches = originalPatches.filter((patch) => patch.op === "replace" && patch.path === voicePatchPath);
  assert.equal(voicePatches.length, 1, "Published header patches must contain the GET /v1/voices parameter schema");
  assert.equal(voicePatches[0].value.length, 1);
  assert.equal(voicePatches[0].value[0].name, "show_legacy");
  assert.equal(voicePatches[0].value[0].in, "query");
  recordFile(files, "header-patches.json", `${JSON.stringify(voicePatches)}\n`);
  substitutions.push({ file: "header-patches.json", label: "OpenAPI fixture patch subset", from: `${originalPatches.length} published operation patches`,
    to: voicePatchPath, occurrences: 1 });

  const sourceCode = `${byPath(files, "index.ts")}\n${byPath(files, "openapi.ts")}`;
  assert.ok(!sourceCode.includes("https://api.elevenlabs.io"), "Local source retains a live ElevenLabs request URL");
  return {
    files,
    substitutions,
    appsVersion: { published: "0.0.1-beta.100", runtime: appsVersion },
    voiceParameters: voicePatches[0].value,
  };
}

