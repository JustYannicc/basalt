import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Serve a catalog package's live OpenAPI definition from a local fixture instead of its publisher.
 *
 * An account check loads the app's tools, so a package whose definition still names the real
 * service cannot load against a fixture that stands in for that service. This builds a minimal
 * definition on the fixture's origin from the package's own options: one operation, plus every
 * object its static patches change, so they apply as they do to the published definition. The
 * package's source then reads that definition from the fixture.
 */
export async function localOpenapi(files, fixtureOrigin, name) {
  const optionsFile = files.find((file) => file.path === "openapi.ts");
  if (optionsFile === undefined) return { files, document: undefined };
  const directory = await mkdtemp(join(tmpdir(), "openapi-fixture-"));
  let options;
  try {
    for (const file of files) {
      await mkdir(join(directory, dirname(file.path)), { recursive: true });
      await writeFile(join(directory, file.path), file.content);
    }
    ({ options } = await import(pathToFileURL(join(directory, "openapi.ts")).href));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  if (!("url" in options.source)) return { files, document: undefined };
  const url = `${fixtureOrigin}/openapi/${name}.json`;
  return {
    files: files.map((file) =>
      file.path === "openapi.ts" ? { ...file, content: file.content.replaceAll(options.source.url, url) } : file,
    ),
    document: minimalDefinition(options.patches ?? [], fixtureOrigin),
  };
}

const unescape = (token) => token.replaceAll("~1", "/").replaceAll("~0", "~");

/** One readable operation on the fixture's origin, and every object the patches change. */
function minimalDefinition(patches, origin) {
  const swagger = patches.some((patch) => patch.path.startsWith("/definitions/"));
  const ok = { "200": { description: "OK", schema: { type: "object" } } };
  const document = swagger
    ? {
        swagger: "2.0",
        info: { title: "Fixture", version: "1" },
        host: new URL(origin).host,
        basePath: "/api",
        schemes: [new URL(origin).protocol.slice(0, -1)],
        paths: { "/fixture.read": { get: { operationId: "fixture_read", responses: ok } } },
      }
    : {
        openapi: "3.0.3",
        info: { title: "Fixture", version: "1" },
        servers: [{ url: origin }],
        paths: {
          "/fixture/read": {
            get: {
              operationId: "fixture_read",
              responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } },
            },
          },
        },
      };
  for (const patch of patches) {
    const parts = patch.path.slice(1).split("/").map(unescape);
    let node = document;
    for (const part of parts.slice(0, -1)) {
      if (typeof node[part] !== "object" || node[part] === null || Array.isArray(node[part])) node[part] = {};
      node = node[part];
    }
    // The patch's target exists, as it does in the published definition.
    const leaf = parts.at(-1);
    if (patch.op !== "add" && !Object.hasOwn(node, leaf)) node[leaf] = {};
  }
  return document;
}
