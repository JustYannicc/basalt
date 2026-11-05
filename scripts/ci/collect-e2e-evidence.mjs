import { lstat, readdir } from "node:fs/promises";
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

export async function collectE2eEvidence(source, destination, ...fallbacks) {
  const summary = { files: 0, bytes: 0 };
  for (const [index, root] of [source, ...fallbacks].entries()) {
    let runs;
    try {
      runs = await entries(root);
    } catch (error) {
      if (index > 0 || fallbacks.length === 0) throw error;
      console.error(`Exported evidence is unavailable (${error.code}); collecting original runs.`);
      continue;
    }
    for (const run of runs) {
      if (!run.isDirectory()) continue;
      const copied = copyE2eEvidence(join(root, run.name), join(destination, run.name), {
        skipExisting: true,
      });
      summary.files += copied.files;
      summary.bytes += copied.bytes;
    }
  }
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
