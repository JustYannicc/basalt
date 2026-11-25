import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type WorkerUpload = {
  readonly worker: string;
  readonly sources: Readonly<Record<string, number>>;
};

const upstream = new URL("../.upstream/", import.meta.url);

/**
 * The skill parser, its YAML reader and the modules that call it directly: carry 0451 swaps the
 * SDK's skill source for a stub, and the hosted skills routes and published-skill routes stay out.
 */
const skillParser =
  /(?:node_modules\/(?:\.bun\/yaml@[^/]+\/node_modules\/)?yaml\/|^packages\/apps\/src\/implementation\/skill-files\.ts$|^packages\/sdk\/src\/implementation\/skill-source\.ts$|^packages\/app-templates\/src\/implementation\/skill-publishing\.ts$|^apps\/hosted\/server\/src\/implementation\/skills\.ts$)/;

/**
 * Any use of the SDK's skills API (`executor.skills.bundle|list|read`), the only other way to the
 * parser: a call, a method passed as a value, or bracket access. String contents are ignored, so a
 * span name is not a use; the whole module is read, so a chain split across lines still matches.
 */
const skillsUse = /\bskills\s*(?:\.|\[\s*["'`])\s*(?:bundle|list|read)\b/;
const withoutStrings = (source: string) =>
  source.replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, (quoted) =>
    /^["'`]\s*(?:bundle|list|read)\s*["'`]$/.test(quoted) ? quoted : `${quoted[0]}${quoted[0]}`,
  );

/**
 * App pages use native HTML parsing, remote storage and a crypto/path platform, and never read an
 * app's skills. Every first-party module the upload contains is read, so a page that could call the
 * skills API fails the build instead of dying at the stub in production.
 */
export function assertAppPagesRuntimeBundle(
  upload: WorkerUpload,
  readSource: (path: string) => string = (path) =>
    readFileSync(fileURLToPath(new URL(path, upstream)), "utf8"),
) {
  if (upload.worker !== "app-pages" || Object.keys(upload.sources).length === 0)
    throw new Error("Expected the attributed production AppPages upload");
  const sources = Object.keys(upload.sources);
  const retained = sources.filter((source) =>
    /node_modules\/(?:parse5\/|@effect\/platform-node(?:-shared)?\/dist\/(?:NodeFileSystem|NodeChildProcessSpawner|NodeTerminal|NodeStdio)\.js$)/.test(
      source,
    ),
  );
  if (retained.length)
    throw new Error(
      `AppPages must not upload an HTML parser or local OS services: ${retained.join(", ")}`,
    );
  const parser = sources.filter((source) => skillParser.test(source));
  if (parser.length)
    throw new Error(`AppPages must not upload the skill parser or YAML: ${parser.join(", ")}`);
  const calls = sources
    .filter((source) => !source.startsWith("(") && !source.includes("node_modules/"))
    .flatMap((source) => {
      const code = withoutStrings(readSource(source));
      // Joining lines lets `executor\n  .skills\n  .list(` match; the line is where the use starts.
      const match = skillsUse.exec(code.replace(/\s+/g, " "));
      if (!match) return [];
      const line = code.split("\n").findIndex((text) => /\bskills\b/.test(text)) + 1;
      return [`${source}:${line}`];
    });
  if (calls.length)
    throw new Error(
      `AppPages must not call the skills API; its skill parser is a stub that dies: ${calls.join(", ")}`,
    );
}

export function checkAppPagesRuntimeBundle() {
  const path = fileURLToPath(
    new URL("apps/hosted/cloud/.generated/worker-uploads/app-pages.json", upstream),
  );
  assertAppPagesRuntimeBundle(JSON.parse(readFileSync(path, "utf8")));
}
