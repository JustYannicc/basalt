import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalFrameworkReleases } from "../.upstream/packages/sdk/src/implementation/basalt-framework-releases.ts";
import { builtFrameworkEvidence } from "./framework-provenance.ts";
import { readFrameworkArtifacts } from "./framework-artifacts.ts";
import { parseFrameworkQualification } from "./deploy-safety/framework-qualification.ts";
import {
  qualifiedFrameworkRegistry,
  renderQualifiedFrameworkRegistry,
} from "./deploy-safety/framework-registry.ts";
import {
  frameworkReceiptPath,
  generatedRegistryPath,
} from "./deploy-safety/framework-registry-release.ts";

export function frameworkHistory() {
  const snapshot = process.env.BASALT_FRAMEWORK_HISTORY;
  if (snapshot) {
    const values: unknown = JSON.parse(readFileSync(snapshot, "utf8"));
    if (!Array.isArray(values))
      throw new Error("BASALT_FRAMEWORK_HISTORY must name an exported qualification array");
    return values.map(parseFrameworkQualification);
  }
  // Releases record no framework qualifications since the custom release layer was removed, so
  // canonical releases are the only history unless an exported snapshot is supplied.
  return [];
}

export async function generateFrameworkRegistry(root: string) {
  const candidate = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const receipt = qualifiedFrameworkRegistry(
    canonicalFrameworkReleases,
    frameworkHistory(),
    await builtFrameworkEvidence(root),
    candidate,
    readFrameworkArtifacts(root),
  );
  writeFileSync(generatedRegistryPath(root), renderQualifiedFrameworkRegistry(receipt.releases));
  mkdirSync(join(root, ".generated"), { recursive: true });
  writeFileSync(frameworkReceiptPath(root), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (import.meta.main) {
  const receipt = await generateFrameworkRegistry(fileURLToPath(new URL("../", import.meta.url)));
  console.log(
    JSON.stringify({
      frameworkQualification: receipt.qualification,
      qualifiedFrameworks: receipt.releases.length,
    }),
  );
}
