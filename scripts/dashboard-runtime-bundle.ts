import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type WorkerUpload = {
  readonly worker: string;
  readonly sources: Readonly<Record<string, number>>;
};

const upstream = new URL("../.upstream/", import.meta.url);

/** Shiki, its grammars, themes and regex engine, and the module that loads them. */
const highlighter =
  /(?:node_modules\/(?:@shikijs\/|shiki\/|oniguruma-to-es\/|oniguruma-parser\/)|packages\/ui\/src\/implementation\/highlight-engine\.ts$)/;
/** The chunk the site's server build names after the engine when it bundles it. */
const engineChunk = /\/web\/dist\/server\/assets\/highlight-engine-[\w-]+\.js$/;

/** The router's manifest chunk: a build-time route table the site build emits without a map. */
const maplessChunk = /\/web\/dist\/server\/assets\/_tanstack-start-manifest_v-[\w-]+\.js$/;

/**
 * What each prebuilt site chunk holds, from its own source map under `root`. A chunk the record
 * names but the site build no longer has, or one without a map, would hide what is inside it, so
 * either fails the check instead of passing it.
 */
export const chunkSources =
  (root: URL) =>
  (path: string): ReadonlyArray<string> => {
    const chunk = fileURLToPath(new URL(path, root));
    if (!existsSync(chunk))
      throw new Error(
        `The dashboard upload record names ${path}, which the site build no longer has; rebuild the Workers`,
      );
    if (existsSync(`${chunk}.map`)) return JSON.parse(readFileSync(`${chunk}.map`, "utf8")).sources;
    if (maplessChunk.test(path)) return [];
    throw new Error(`${path} has no source map, so the dashboard check cannot see inside it`);
  };

/**
 * Carry 0804 swaps the code highlighter for a stub in the dashboard's server build, which the
 * dashboard Worker uploads; the browser loads the real engine. The Worker attributes the site's
 * prebuilt chunks to themselves, so each chunk's own source map names what is inside it.
 */
export function assertDashboardRuntimeBundle(
  upload: WorkerUpload,
  clientAssets: ReadonlyArray<string>,
  mapSources: (path: string) => ReadonlyArray<string> = chunkSources(upstream),
) {
  if (upload.worker !== "dashboard" || Object.keys(upload.sources).length === 0)
    throw new Error("Expected the attributed production dashboard upload");
  const retained = Object.keys(upload.sources).flatMap((source) => {
    if (highlighter.test(source) || engineChunk.test(source)) return [source];
    if (!source.includes("/web/dist/server/")) return [];
    const inside = mapSources(source).filter((path) => highlighter.test(path));
    return inside.length ? [`${source} (${inside.join(", ")})`] : [];
  });
  if (retained.length)
    throw new Error(`The dashboard must not upload the code highlighter: ${retained.join("; ")}`);
  if (!clientAssets.some((asset) => /^highlight-engine-[\w-]+\.js$/.test(asset)))
    throw new Error("The dashboard's browser build must keep the code highlighter");
}

export function checkDashboardRuntimeBundle() {
  const site = new URL("apps/hosted/cloud/web/dist/client/assets/", upstream);
  const upload = new URL("apps/hosted/cloud/.generated/worker-uploads/dashboard.json", upstream);
  assertDashboardRuntimeBundle(
    JSON.parse(readFileSync(fileURLToPath(upload), "utf8")),
    readdirSync(fileURLToPath(site)),
  );
}
