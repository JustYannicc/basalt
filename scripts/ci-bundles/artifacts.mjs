import assert from "node:assert/strict";
import { cp, glob, mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { interpolate } from "./plan.mjs";

export async function collect(suite, workspace, context, destination) {
  for (const artifact of suite.artifacts) {
    let matches = 0;
    for (const pattern of interpolate(artifact.path, context).split("\n").filter(Boolean)) {
      for await (const path of glob(pattern, { cwd: workspace })) {
        const source = resolve(workspace, path);
        const relativePath = source.startsWith(`${workspace}/`) ? relative(workspace, source)
          : source.startsWith(`${context.temp}/`) ? join("runner-temp", relative(context.temp, source)) : undefined;
        assert.ok(relativePath && !relativePath.startsWith(".."), "Artifact escaped its suite workspace");
        const target = join(destination, "artifacts", relativePath);
        await mkdir(dirname(target), { recursive: true });
        await cp(source, target, { recursive: true, force: true });
        matches++;
      }
    }
    if (!matches && artifact["if-no-files-found"] === "error")
      throw new Error(`Required artifact is missing: ${interpolate(artifact.name, context)}`);
  }
}
