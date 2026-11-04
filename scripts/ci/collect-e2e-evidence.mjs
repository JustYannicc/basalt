import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function entries(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function collectE2eEvidence(source, destination) {
  const summary = { files: 0, bytes: 0 };
  async function copy(file) {
    let info;
    try {
      info = await lstat(file);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (!info.isFile()) return;
    const output = join(destination, relative(source, file));
    await mkdir(dirname(output), { recursive: true });
    await copyFile(file, output);
    summary.files++;
    summary.bytes += info.size;
  }
  async function report(directory) {
    for (const entry of await entries(directory)) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await report(file);
      else if (entry.isFile()) await copy(file);
    }
  }
  // Runtime directories contain package links back into the checkout. Never glob through them.
  for (const run of await entries(source)) {
    if (!run.isDirectory()) continue;
    for (const target of await entries(join(source, run.name))) {
      if (!target.isDirectory() || !["local", "self-host"].includes(target.name)) continue;
      const directory = join(source, run.name, target.name);
      for (const entry of await entries(directory)) {
        if (entry.name === "report" && entry.isDirectory())
          await report(join(directory, entry.name));
        if (["results.json", "server.log", "cloud.log"].includes(entry.name))
          await copy(join(directory, entry.name));
        if (entry.name !== "scenarios" || !entry.isDirectory()) continue;
        for (const scenario of await entries(join(directory, "scenarios"))) {
          if (!scenario.isDirectory()) continue;
          for (const log of ["server.log", "cloud.log"])
            await copy(join(directory, "scenarios", scenario.name, log));
        }
      }
    }
  }
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination)
    throw new Error("Expected an E2E run root and an evidence destination");
  const summary = await collectE2eEvidence(resolve(source), resolve(destination));
  console.log(`Retained E2E evidence: ${summary.files} regular files, ${summary.bytes} bytes`);
}
