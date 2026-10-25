import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { exactVersion } from "./source.mjs";

export function hostSourceDigest(root) {
  const hash = createHash("sha256").update(readFileSync(join(root, "upstream.json")));
  for (const name of readdirSync(join(root, "patches"))
    .filter((name) => name.endsWith(".patch"))
    .sort())
    hash.update(name).update(readFileSync(join(root, "patches", name)));
  return hash.digest("hex");
}

export function hostVersion(root) {
  const prepared = join(root, ".upstream/packages/apps/package.json");
  const lightweight = join(root, ".ci-tools/app-lint-host.json");
  let manifest;
  if (existsSync(prepared)) manifest = JSON.parse(readFileSync(prepared, "utf8"));
  else if (existsSync(lightweight)) {
    const saved = JSON.parse(readFileSync(lightweight, "utf8"));
    if (saved.source !== hostSourceDigest(root))
      throw new Error("Framework manifest is stale; rerun prepare-host.mjs");
    manifest = saved.manifest;
  } else throw new Error("Run prepare:upstream or node scripts/app-lint/prepare-host.mjs first");
  if (manifest.name !== "apps" || !exactVersion(manifest.version))
    throw new Error("Invalid host framework version");
  return manifest.version;
}
