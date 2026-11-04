import assert from "node:assert/strict";
import { cp, glob, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { interpolate } from "./plan.mjs";

async function hasFiles(path) {
  const entry = await stat(path);
  if (entry.isFile()) return true;
  if (entry.isDirectory()) {
    for (const child of await readdir(path)) if (await hasFiles(join(path, child))) return true;
  }
  return false;
}

export async function collect(suite, workspace, context, destination) {
  const retained = new Set();
  for (const artifact of suite.artifacts) {
    let matches = 0;
    const sources = new Set();
    for (const pattern of interpolate(artifact.path, context).split("\n").filter(Boolean)) {
      for await (const path of glob(pattern, { cwd: workspace })) {
        const source = resolve(workspace, path);
        sources.add(source);
      }
    }
    for (const source of [...sources].sort((a, b) => a.length - b.length)) {
      if ([...retained].some((parent) => source === parent || source.startsWith(`${parent}/`))) {
        matches++;
        continue;
      }
      const relativePath = source.startsWith(`${workspace}/`) ? relative(workspace, source)
        : source.startsWith(`${context.temp}/`) ? join("runner-temp", relative(context.temp, source)) : undefined;
      assert.ok(relativePath && !relativePath.startsWith(".."), "Artifact escaped its suite workspace");
      if (!await hasFiles(source)) continue;
      const target = join(destination, "artifacts", relativePath);
      await mkdir(dirname(target), { recursive: true });
      // The suite has stopped. Moving evidence avoids recopying large report trees for every glob child.
      try { await rename(source, target); }
      catch (error) {
        if (error.code !== "EXDEV") throw error;
        await cp(source, target, { recursive: true, force: true });
        await rm(source, { recursive: true, force: true });
      }
      retained.add(source);
      matches++;
    }
    if (!matches && artifact["if-no-files-found"] === "error")
      throw new Error(`Required artifact is missing: ${interpolate(artifact.name, context)}`);
    if (!matches && (artifact["if-no-files-found"] ?? "warn") === "warn")
      console.log(`::warning title=${suite.key ?? "Boat evidence"}::No files for ${interpolate(artifact.name, context)}`);
  }
}
