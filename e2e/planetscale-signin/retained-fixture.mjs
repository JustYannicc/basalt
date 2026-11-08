import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const origins = [
  ["https://planetscale.com/docs", (origin) => `${origin}/docs`],
  ["https://api.planetscale.com", (origin) => origin],
  ["https://app.planetscale.com", (origin) => origin],
  ["https://auth.planetscale.com", (origin) => origin],
];

const planetScaleCredentialHosts =
  /hosts:\s*\[\s*"api\.planetscale\.com"\s*,\s*"app\.planetscale\.com"\s*,\s*"auth\.planetscale\.com"\s*\]/g;

const count = (value, pattern) => [...value.matchAll(pattern)].length;

const rewrite = (content, origin) => {
  let moved = content;
  for (const [source, target] of origins) moved = moved.replaceAll(source, target(origin));
  return moved.replace(
    planetScaleCredentialHosts,
    `hosts: [${JSON.stringify(new URL(origin).host)}]`,
  );
};

const readFiles = async (root, filename, serviceOrigin, appsVersion) => {
  assert.equal(typeof appsVersion, "string", "Use the current apps runtime pin");
  const origin = new URL(serviceOrigin).origin;
  const host = new URL(origin).host;
  const source = JSON.parse(await readFile(join(root, "src", "catalog", filename), "utf8"));
  assert.equal(source.package, "@executor.sh/planetscale");
  assert.ok(Array.isArray(source.files), `${filename} must contain the published source files`);

  const sourceIndex = source.files.find((file) => file.path === "index.ts");
  const movedHostCount = count(sourceIndex?.content ?? "", planetScaleCredentialHosts);
  assert.ok(movedHostCount > 0, `${filename} must declare PlanetScale credential hosts`);

  const files = source.files.map((file) => ({
    ...file,
    content: rewrite(file.content, origin),
  }));
  const index = files.find((file) => file.path === "index.ts");
  const movedHostDeclaration = `hosts: [${JSON.stringify(host)}]`;
  assert.equal(
    index.content.split(movedHostDeclaration).length - 1,
    movedHostCount,
    `${filename} moves every credential host to the fixture`,
  );

  const packageFile = files.find((file) => file.path === "package.json");
  assert.ok(packageFile, `${filename} must include package.json`);
  const packageJson = JSON.parse(packageFile.content);
  assert.ok(packageJson.dependencies?.apps, `${filename} must depend on the apps runtime`);
  packageJson.dependencies.apps = appsVersion;
  packageFile.content = JSON.stringify(packageJson);

  return files;
};

/** Read the checked-in published and current source; only fixture origins and the runtime pin move. */
export const createPlanetScaleRetainedFixture = ({ root, serviceOrigin, appsVersion }) => ({
  publishedFiles: () => readFiles(root, "planetscale.published.json", serviceOrigin, appsVersion),
  currentFiles: () => readFiles(root, "planetscale.json", serviceOrigin, appsVersion),
});
