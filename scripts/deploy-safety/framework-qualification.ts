import { SafetyGateError } from "./contracts.ts";

export type FrameworkReleaseProvenance = {
  version: string;
  sha256: string;
  protocol: number;
  browserSha256: string;
  source: { origin: "basalt"; revision: string; sha256: string };
};

export type FrameworkQualification = {
  producerGitCommit: string;
  provenance: FrameworkReleaseProvenance;
  registrySha256: string;
};

export function parseFrameworkQualification(value: unknown): FrameworkQualification {
  const qualification = object(value, "frameworkQualification");
  const provenance = object(qualification.provenance, "frameworkQualification.provenance");
  const source = object(provenance.source, "frameworkQualification.provenance.source");
  const producer = qualification.producerGitCommit;
  if (typeof producer !== "string" || !/^[a-f0-9]{40}$/i.test(producer))
    throw new SafetyGateError(
      "frameworkQualification.producerGitCommit must be a 40-character commit SHA",
    );
  if (
    typeof provenance.protocol !== "number" ||
    !Number.isInteger(provenance.protocol) ||
    provenance.protocol <= 0
  )
    throw new SafetyGateError(
      "frameworkQualification.provenance.protocol must be a positive integer",
    );
  if (source.origin !== "basalt")
    throw new SafetyGateError("frameworkQualification.provenance.source.origin must be basalt");
  return {
    producerGitCommit: producer.toLowerCase(),
    provenance: {
      version: text(provenance.version, "frameworkQualification.provenance.version"),
      sha256: digest(provenance.sha256, "frameworkQualification.provenance.sha256"),
      protocol: provenance.protocol,
      browserSha256: digest(
        provenance.browserSha256,
        "frameworkQualification.provenance.browserSha256",
      ),
      source: {
        origin: "basalt",
        revision: text(source.revision, "frameworkQualification.provenance.source.revision"),
        sha256: digest(source.sha256, "frameworkQualification.provenance.source.sha256"),
      },
    },
    registrySha256: digest(qualification.registrySha256, "frameworkQualification.registrySha256"),
  };
}

function object(value: unknown, property: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SafetyGateError(`${property} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, property: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new SafetyGateError(`${property} must be a non-empty string`);
  return value;
}

function digest(value: unknown, property: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new SafetyGateError(`${property} must be a lowercase SHA-256 digest`);
  return value;
}
