import { readFileSync } from "node:fs";
import { stableStringify } from "./deploy-safety/contracts.ts";
import { frameworkDifferences, refuseFramework } from "./deploy-safety/framework-refusal.ts";
import {
  candidateFrameworkEvidence,
  frameworkReceiptPath,
} from "./deploy-safety/framework-registry-release.ts";
import {
  parseFrameworkBuildReceipt,
  renderQualifiedFrameworkRegistry,
  samePublication,
} from "./deploy-safety/framework-registry.ts";

/** Offline source checks bind generated data to the candidate and its published bytes. */
export function preparedFrameworkRegistrySource(root: string, candidate: string) {
  const receipt = parseFrameworkBuildReceipt(
    JSON.parse(readFileSync(frameworkReceiptPath(root), "utf8")),
  );
  const evidence = candidateFrameworkEvidence(root, candidate);
  const differences = frameworkDifferences("receipt.produced", evidence.actual, receipt.produced);
  if (receipt.qualification.producerGitCommit !== candidate)
    differences.push({
      resource: "framework-qualification.json",
      property: "producerGitCommit",
      expected: candidate,
      observed: receipt.qualification.producerGitCommit,
    });
  for (const property of ["runtimeJsonSha256", "frameworkJsonSha256"] as const)
    if (receipt.qualification.artifacts[property] !== evidence.artifacts[property])
      differences.push({
        resource: "framework-qualification.json",
        property: `artifacts.${property}`,
        expected: evidence.artifacts[property],
        observed: receipt.qualification.artifacts[property],
      });
  for (const canonical of evidence.canonical) {
    const retained = receipt.releases.find(
      (entry) => entry.version === canonical.version && entry.sha256 === canonical.sha256,
    );
    const resource = `${canonical.version}/${canonical.sha256}`;
    if (retained) differences.push(...frameworkDifferences(resource, canonical, retained));
    else
      differences.push({
        resource,
        property: "canonical entry",
        expected: "present",
        observed: "missing",
      });
  }
  const qualification = receipt.qualification.provenance;
  if (!samePublication(evidence.actual, qualification))
    differences.push(
      ...frameworkDifferences("qualification.provenance", evidence.actual, qualification),
    );
  if (!receipt.releases.some((entry) => stableStringify(entry) === stableStringify(qualification)))
    differences.push({
      resource: "framework-qualification.json",
      property: "qualification.provenance",
      expected: "present in generated registry",
      observed: "missing",
    });
  if (differences.length)
    refuseFramework("Prepared framework registry differs from its build", differences);
  return renderQualifiedFrameworkRegistry(receipt.releases);
}
