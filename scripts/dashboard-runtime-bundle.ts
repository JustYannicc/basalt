import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type WorkerUpload = {
  readonly worker: string;
  readonly sources: Readonly<Record<string, number>>;
};

const upstream = new URL("../.upstream/", import.meta.url);

/** The grammars the dashboard's server engine carries; every other grammar stays in the browser. */
export const serverGrammars = ["typescript", "json", "shellscript"] as const;
const grammar =
  /node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?@shikijs\/langs\/dist\/([\w-]+)\.mjs$/;
/** The browser's engine with every grammar, and the chunk a server build would name after it. */
const fullEngine =
  /(?:packages\/ui\/src\/implementation\/highlight-engine\.ts|\/web\/dist\/server\/assets\/highlight-engine-[\w-]+\.js)$/;

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
 * Carry 0804 gives the dashboard's server build, which the dashboard Worker uploads, an engine
 * with only the server grammars; the browser loads the full engine. The Worker attributes the
 * site's prebuilt chunks to themselves, so each chunk's own source map names what is inside it.
 */
export function assertDashboardRuntimeBundle(
  upload: WorkerUpload,
  clientAssets: ReadonlyArray<string>,
  mapSources: (path: string) => ReadonlyArray<string> = chunkSources(upstream),
) {
  if (upload.worker !== "dashboard" || Object.keys(upload.sources).length === 0)
    throw new Error("Expected the attributed production dashboard upload");
  // Each uploaded module with where it sits: a source of its own, or a site chunk's map source.
  const uploaded = Object.keys(upload.sources).flatMap((source) => [
    { path: source, label: source },
    ...(source.includes("/web/dist/server/")
      ? mapSources(source).map((path) => ({ path, label: `${source} (${path})` }))
      : []),
  ]);
  const grammars = new Set<string>();
  const refused: string[] = [];
  for (const { path, label } of uploaded) {
    const name = grammar.exec(path)?.[1];
    if (name !== undefined) grammars.add(name);
    const allowed = name === undefined || (serverGrammars as ReadonlyArray<string>).includes(name);
    if (!allowed || fullEngine.test(path)) refused.push(label);
  }
  if (refused.length)
    throw new Error(
      `The dashboard must upload only the ${serverGrammars.join(", ")} grammars: ${refused.join("; ")}`,
    );
  const missing = serverGrammars.filter((name) => !grammars.has(name));
  if (missing.length)
    throw new Error(`The dashboard's server render must keep the ${missing.join(", ")} grammars`);
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
