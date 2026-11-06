import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { declaredScenarios, implementsScenario } from "./mock-scenarios.ts";
import { parseDocument } from "yaml";
import { patternForGroup, readDeclarations } from "../ci/declarations.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const word = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9-]*$/.test(value);
const targets = ["self-host", "local", "cloud"];

type Proof = { scenario: string; target: string; job: string };
type Contract = {
  id: string;
  artifact: { name: string; sha256: string };
  requirements: {
    id: string;
    text: string;
    proofs: Proof[];
    gap?: { state: "open"; owner: string; reason: string };
  }[];
  approvalDeltas: string[];
};

export function parseMockContract(value: unknown): Contract {
  if (
    !object(value) ||
    value.version !== 1 ||
    !word(value.id) ||
    !object(value.artifact) ||
    typeof value.artifact.name !== "string" ||
    !/^[a-z0-9][a-z0-9.-]+\.html$/.test(value.artifact.name) ||
    typeof value.artifact.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.artifact.sha256) ||
    (value.approvalDeltas !== undefined &&
      (!Array.isArray(value.approvalDeltas) ||
        value.approvalDeltas.some((delta) => typeof delta !== "string" || !delta.trim()))) ||
    !Array.isArray(value.requirements) ||
    !value.requirements.length
  )
    throw new Error("Invalid approved-mock contract");
  const requirements = value.requirements.map((requirement: unknown) => {
    if (
      !object(requirement) ||
      !word(requirement.id) ||
      typeof requirement.text !== "string" ||
      !requirement.text.trim()
    )
      throw new Error("Every approved requirement needs a named behavioral proof");
    if (requirement.gap !== undefined) {
      const gap = requirement.gap;
      if (
        requirement.proofs !== undefined ||
        !object(gap) ||
        gap.state !== "open" ||
        typeof gap.owner !== "string" ||
        !gap.owner.trim() ||
        typeof gap.reason !== "string" ||
        !gap.reason.trim()
      )
        throw new Error("An open gap needs an owner and reason, without claimed proofs");
      return {
        id: requirement.id,
        text: requirement.text,
        proofs: [],
        gap: { state: "open" as const, owner: gap.owner, reason: gap.reason },
      };
    }
    if (!Array.isArray(requirement.proofs) || !requirement.proofs.length)
      throw new Error("Every approved requirement needs a behavioral proof or explicit open gap");
    const proofs = requirement.proofs.map((proof: unknown) => {
      if (
        !object(proof) ||
        typeof proof.scenario !== "string" ||
        !/^[a-zA-Z][a-zA-Z0-9]*$/.test(proof.scenario) ||
        typeof proof.target !== "string" ||
        !targets.includes(proof.target) ||
        !word(proof.job)
      )
        throw new Error("Invalid approved-mock proof");
      return { scenario: proof.scenario, target: proof.target, job: proof.job };
    });
    return { id: requirement.id, text: requirement.text, proofs };
  });
  if (new Set(requirements.map(({ id }) => id)).size !== requirements.length)
    throw new Error("Duplicate approved-mock requirement");
  return {
    id: value.id,
    artifact: { name: value.artifact.name, sha256: value.artifact.sha256 },
    requirements,
    approvalDeltas: (value.approvalDeltas ?? []) as string[],
  };
}

// Computed shell selectors establish coverage only through the verified declaration CLI.
function runsScenario(
  root: string,
  job: Record<string, unknown>,
  proof: Proof,
  scenario: { file: string; title: string },
) {
  if (job["continue-on-error"] !== undefined || !Array.isArray(job.steps)) return false;
  return job.steps.some((step: unknown) => {
    if (
      !object(step) ||
      step.if !== undefined ||
      step["continue-on-error"] !== undefined ||
      step["working-directory"] !== ".upstream" ||
      typeof step.run !== "string"
    )
      return false;
    return [
      ...step.run.matchAll(
        /^\s*bun run e2e:(self-host|local|cloud)\s+--test-name\s+(["'])(.*?)\2(?:\s+--workers\s+[1-9][0-9]*)?\s*$/gs,
      ),
    ].some((match) => {
      if (match[1] !== proof.target) return false;
      try {
        const declared = /^\$\(node \.\.\/scripts\/ci\/e2e-pattern\.ts ([a-z0-9:-]+)\)$/.exec(
          match[3]!,
        );
        if (declared) {
          if (match[2] !== '"') return false;
          const { files, groups } = readDeclarations(root);
          const group = groups[declared[1]!];
          return (
            group?.job === proof.job &&
            group.target === proof.target &&
            files[scenario.file]?.runs[proof.scenario]?.includes(declared[1]!) === true &&
            new RegExp(patternForGroup(declared[1]!, scenario.file, root)).test(scenario.title)
          );
        }
        if (/\$[a-zA-Z{(]|`/.test(match[3]!)) return false;
        return new RegExp(match[3]!).test(scenario.title);
      } catch {
        return false;
      }
    });
  });
}

function enforcesAggregate(job: Record<string, unknown>) {
  return (
    job.if === "always()" &&
    job["continue-on-error"] === undefined &&
    job.defaults === undefined &&
    Array.isArray(job.steps) &&
    job.steps.some(
      (step: unknown) =>
        object(step) &&
        step.if === undefined &&
        step["continue-on-error"] === undefined &&
        step["working-directory"] === undefined &&
        step.shell === undefined &&
        typeof step.run === "string" &&
        step.run.trim() === "node scripts/ci/gate.ts" &&
        object(step.env) &&
        step.env.CI_NEEDS === "${{ toJSON(needs) }}" &&
        step.env.CI_JOBS === "${{ needs.select.outputs.jobs }}" &&
        step.env.CI_BOAT_JOBS === "${{ needs.select.outputs.boat_jobs }}",
    )
  );
}

export function mockConformanceErrors(root: string, requiredJobs: readonly string[]) {
  const directory = join(root, "e2e/conformance");
  if (!existsSync(directory)) return ["Approved-mock registry is missing"];
  const records = readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort();
  if (!records.length) return ["Approved-mock registry is empty"];
  const errors: string[] = [],
    identities = new Set<string>();
  const plan = declaredScenarios(readFileSync(join(root, ".upstream/e2e/test-plan.ts"), "utf8"));
  if (existsSync(join(root, "e2e/plans"))) {
    try {
      for (const [file, entry] of Object.entries(readDeclarations(root).files))
        for (const [key, scenario] of Object.entries(entry.scenarios))
          plan.set(key, {
            file,
            title: scenario.title,
            targets: Object.entries(scenario.targets).flatMap(([target, value]) =>
              object(value) && value.status === "scheduled" ? [target] : [],
            ),
          });
    } catch {
      return ["Invalid per-file CI declarations"];
    }
  }
  const workflow = parseDocument(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"), {
    uniqueKeys: true,
  });
  if (workflow.errors.length) return ["Invalid CI workflow YAML"];
  const data: unknown = workflow.toJSON();
  if (
    !object(data) ||
    !object(data.jobs) ||
    !object(data.jobs.check) ||
    !Array.isArray(data.jobs.check.needs) ||
    data.defaults !== undefined ||
    !enforcesAggregate(data.jobs.check)
  )
    return ["Required aggregate CI gate is missing"];
  const jobs = data.jobs,
    gate = data.jobs.check.needs;
  for (const record of records) {
    let contract: Contract;
    try {
      contract = parseMockContract(JSON.parse(readFileSync(join(directory, record), "utf8")));
    } catch {
      errors.push(`${record}: invalid approved-mock contract`);
      continue;
    }
    if (record !== `${contract.id}.json` || identities.has(contract.id))
      errors.push(`${record}: duplicate or mismatched approved-mock identity`);
    identities.add(contract.id);
    for (const requirement of contract.requirements)
      for (const proof of requirement.proofs) {
        const label = `${contract.id}/${requirement.id}/${proof.scenario}/${proof.target}`;
        const scenario = plan.get(proof.scenario);
        if (
          !scenario ||
          !/^[a-z0-9-]+\.spec\.ts$/.test(scenario.file) ||
          !scenario.targets.includes(proof.target)
        ) {
          errors.push(`${label}: scenario is missing or not scheduled`);
          continue;
        }
        const path = join(root, ".upstream/e2e/tests", scenario.file);
        if (!existsSync(path) || !implementsScenario(readFileSync(path, "utf8"), proof.scenario))
          errors.push(`${label}: behavioral scenario implementation is missing`);
        const job = jobs[proof.job];
        if (
          !requiredJobs.includes(proof.job) ||
          !gate.includes(proof.job) ||
          !object(job) ||
          job.if !== `contains(fromJSON(needs.select.outputs.hosted_jobs), '${proof.job}')` ||
          !runsScenario(root, job, proof, scenario)
        )
          errors.push(`${label}: required CI job does not run this scenario`);
      }
  }
  return errors;
}

export function mockConformanceGaps(root: string) {
  const directory = join(root, "e2e/conformance");
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .flatMap((file) => {
      const contract = parseMockContract(JSON.parse(readFileSync(join(directory, file), "utf8")));
      return contract.requirements.flatMap((requirement) =>
        requirement.gap
          ? [
              {
                contract: contract.id,
                requirement: requirement.id,
                ...requirement.gap,
              },
            ]
          : [],
      );
    });
}
