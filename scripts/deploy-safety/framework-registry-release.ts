import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SafetyGateError } from "./contracts.ts";
import { refuseFramework } from "./framework-refusal.ts";
import { parseFrameworkProvenance } from "./framework-qualification.ts";
import { readFrameworkArtifacts } from "../framework-artifacts.ts";
import { validateFrameworkBuildReceipt } from "./framework-registry.ts";
import { readQualifiedFrameworkHistory } from "./github-ledger.ts";
import type { Fetcher } from "./http.ts";

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

function checkedFile(path: string, candidate: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return refuseFramework(
      `Framework qualification for candidate ${candidate} cannot read its checked artifact`,
      [
        {
          resource: path,
          property: "file",
          expected: "readable UTF-8 artifact",
          observed: "unavailable",
        },
      ],
    );
  }
}

/** Fresh production history is trusted by the controller; no build-time snapshot can enroll. */
export async function releaseFrameworkQualification(
  sourceRoot: string,
  candidate: string,
  repository: string,
  token: string,
  fetcher: Fetcher = fetch,
) {
  const root = resolve(sourceRoot);
  const evidence = candidateFrameworkEvidence(root, candidate);
  const history = await readQualifiedFrameworkHistory({ repository, token }, fetcher);
  const receiptPath = frameworkReceiptPath(root);
  const receiptText = checkedFile(receiptPath, candidate);
  let receipt: unknown;
  try {
    receipt = JSON.parse(receiptText);
  } catch {
    refuseFramework(
      `Framework qualification for candidate ${candidate} requires its checked receipt`,
      [
        {
          resource: receiptPath,
          property: "receipt.format",
          expected: "JSON build receipt",
          observed: "malformed",
        },
      ],
    );
  }
  const generated = checkedFile(generatedRegistryPath(root), candidate);
  try {
    return validateFrameworkBuildReceipt(
      receipt,
      candidate,
      evidence.actual,
      evidence.canonical,
      history,
      generated,
      evidence.artifacts,
    );
  } catch (error) {
    if (!(error instanceof SafetyGateError)) throw error;
    throw new SafetyGateError(`Framework candidate ${candidate} at ${root}: ${error.message}`);
  }
}
