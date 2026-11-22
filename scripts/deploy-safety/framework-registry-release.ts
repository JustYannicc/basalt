import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { refuseFramework } from "./framework-refusal.ts";
import { parseFrameworkProvenance } from "./framework-qualification.ts";
import { readFrameworkArtifacts } from "../framework-artifacts.ts";

export const frameworkReceiptPath = (root: string) =>
  join(root, ".generated/framework-qualification.json");
export const generatedRegistryPath = (root: string) =>
  join(root, ".upstream/packages/sdk/src/implementation/basalt-qualified-framework-releases.ts");

const candidateEvidenceProgram = `
const { builtFrameworkEvidence } = await import(process.argv[1]);
const { canonicalFrameworkReleases } = await import(process.argv[2]);
const actual = await builtFrameworkEvidence(process.argv[3]);
process.stdout.write(JSON.stringify({ actual, canonical: canonicalFrameworkReleases }));
`;

/** The prepared candidate owns its SDK, release constants and producer calculation. */
export function candidateFrameworkEvidence(sourceRoot: string, candidate: string) {
  const root = resolve(sourceRoot);
  const producer = join(root, "scripts/framework-provenance.ts");
  const canonical = join(
    root,
    ".upstream/packages/sdk/src/implementation/basalt-framework-releases.ts",
  );
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      candidateEvidenceProgram,
      pathToFileURL(producer).href,
      pathToFileURL(canonical).href,
      root,
    ],
    {
      cwd: root,
      env: { PATH: process.env.PATH },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const reason = `Framework qualification for candidate ${candidate} requires its prepared producer`;
  if (result.error || result.status !== 0)
    refuseFramework(reason, [
      {
        resource: producer,
        property: "producer.exitStatus",
        expected: 0,
        observed: result.status ?? "not completed",
      },
    ]);
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    refuseFramework(reason, [
      {
        resource: producer,
        property: "producer.output",
        expected: "JSON evidence",
        observed: "malformed",
      },
    ]);
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("actual" in value) ||
    !("canonical" in value) ||
    !Array.isArray(value.canonical)
  )
    refuseFramework(reason, [
      {
        resource: producer,
        property: "producer.output",
        expected: "actual provenance and canonical array",
        observed: "missing or malformed fields",
      },
    ]);
  const parse = (input: unknown, resource: string, property: string) => {
    try {
      return parseFrameworkProvenance(input);
    } catch {
      return refuseFramework(reason, [
        { resource, property, expected: "framework provenance", observed: "malformed" },
      ]);
    }
  };
  return {
    actual: parse(value.actual, producer, "actual"),
    canonical: value.canonical.map((entry, index) =>
      parse(entry, canonical, `canonical[${index}]`),
    ),
    artifacts: readFrameworkArtifacts(root),
  };
}
