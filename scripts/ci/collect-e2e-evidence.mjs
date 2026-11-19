import { lstat, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { copyE2eEvidence } from "../e2e-evidence.ts";

async function entries(directory) {
  try {
    const info = await lstat(directory);
    return info.isDirectory() && !info.isSymbolicLink()
      ? await readdir(directory, { withFileTypes: true })
      : [];
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return [];
    throw error;
  }
}

async function collectRuns(roots, destination, include) {
  const summary = { files: 0, bytes: 0 };
  for (const [index, root] of roots.entries()) {
    let runs;
    try {
      runs = await entries(root);
    } catch (error) {
      if (index > 0 || roots.length === 1) throw error;
      console.error(`Exported evidence is unavailable (${error.code}); collecting original runs.`);
      continue;
    }
    for (const run of runs) {
      if (!run.isDirectory() || !include(index, run.name)) continue;
      const copied = copyE2eEvidence(join(root, run.name), join(destination, run.name), {
        skipExisting: true,
      });
      summary.files += copied.files;
      summary.bytes += copied.bytes;
    }
  }
  return summary;
}

export function collectE2eEvidence(source, destination, ...fallbacks) {
  return collectRuns([source, ...fallbacks], destination, () => true);
}

/** The run directories each root holds now, so later runs can be attributed to one file. */
export async function runNames(roots) {
  return Promise.all(
    roots.map(
      async (root) =>
        new Set((await entries(root)).filter((run) => run.isDirectory()).map((run) => run.name)),
    ),
  );
}

/**
 * Collect only runs that appeared after `before`, then remove them from the shared roots, so the
 * next file in the same checkout can neither overwrite nor mix with this file's evidence.
 */
export async function collectNewE2eEvidence(roots, before, destination) {
  const after = await runNames(roots);
  const summary = await collectRuns(roots, destination, (index, name) => !before[index]?.has(name));
  for (const [index, root] of roots.entries())
    for (const name of after[index])
      if (!before[index]?.has(name)) await rm(join(root, name), { recursive: true, force: true });
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, destination, ...fallbacks] = process.argv.slice(2);
  if (!source || !destination)
    throw new Error(
      "Expected an exported run root, evidence destination and optional original-run fallbacks",
    );
  const summary = await collectE2eEvidence(
    resolve(source),
    resolve(destination),
    ...fallbacks.map((path) => resolve(path)),
  );
  console.log(`Retained E2E evidence: ${summary.files} regular files, ${summary.bytes} bytes`);
}
