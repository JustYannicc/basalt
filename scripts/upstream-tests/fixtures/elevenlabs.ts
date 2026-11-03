import { readFileSync } from "node:fs";

type Json = Record<string, unknown>;
type Patch = { op: "add" | "remove" | "replace"; path: string; value?: unknown };

/** The official ElevenLabs catalog package as it was served when its tools stopped loading. */
export const packageBytes = readFileSync(new URL("./elevenlabs.catalog.json", import.meta.url));
export const elevenlabs = JSON.parse(packageBytes.toString()) as {
  package: string;
  files: { path: string; content: string }[];
};
export const packageFile = (path: string) => elevenlabs.files.find((file) => file.path === path)!.content;
export const packageSha256 = "7236a4734594f6aa04c2f1423f22ca191c0ac6f6c7311d795f0d533db4903905";

/** ElevenLabs removed these routes after the package's header patches were generated. */
export const removedRoutes = ["/v1/speech-to-speech/{voice_id}", "/v1/speech-to-speech/{voice_id}/stream"];

// The shared schemas the patched parameters reference, from ElevenLabs' live document on 2026-11-03.
const parameterSchemas = JSON.parse(
  readFileSync(new URL("./elevenlabs.parameter-schemas.json", import.meta.url), "utf8"),
) as Json;

/**
 * ElevenLabs' current definition, as far as the package's patches reach: every operation a header
 * patch targets, each still taking the `xi-api-key` header that patch removes, except the removed
 * routes, plus the `/docs` redirect the package removes.
 */
export function currentDocument(origin = "https://api.elevenlabs.io") {
  const patches = JSON.parse(packageFile("header-patches.json")) as Patch[];
  const ok = { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } };
  const paths: Record<string, Record<string, Json>> = { "/docs": { get: { responses: ok } } };
  for (const patch of patches) {
    const match = /^\/paths\/([^/]+)\/(\w+)\/parameters$/.exec(patch.path);
    if (!match || !Array.isArray(patch.value)) continue;
    const path = match[1]!.replaceAll("~1", "/").replaceAll("~0", "~");
    if (removedRoutes.includes(path)) continue;
    paths[path] = {
      ...paths[path],
      [match[2]!]: {
        parameters: [
          ...patch.value,
          { name: "xi-api-key", in: "header", required: false, schema: { type: "string" } },
        ],
        responses: ok,
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "ElevenLabs", version: "1" },
    servers: [{ url: origin }],
    paths,
    components: { schemas: parameterSchemas },
  };
}

/** How many tools the package offers on that definition: every operation but `/docs`. */
export const expectedTools = (document: ReturnType<typeof currentDocument>) =>
  Object.values(document.paths).reduce((total, item) => total + Object.keys(item).length, 0) - 1;
