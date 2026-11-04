import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { parseDocument } from "yaml";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const word = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9-]*$/.test(value);
const targets = ["self-host", "local", "cloud"];

type Proof = { scenario: string; target: string; job: string };
type Contract = {
  id: string;
  artifact: { name: string; sha256: string };
  requirements: { id: string; text: string; proofs: Proof[] }[];
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
    !Array.isArray(value.requirements) ||
    !value.requirements.length
  )
    throw new Error("Invalid approved-mock contract");
  const requirements = value.requirements.map((requirement: unknown) => {
    if (
      !object(requirement) ||
      !word(requirement.id) ||
      typeof requirement.text !== "string" ||
      !requirement.text.trim() ||
      !Array.isArray(requirement.proofs) ||
      !requirement.proofs.length
    )
      throw new Error("Every approved requirement needs a named behavioral proof");
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
  };
}

const propertyName = (name: ts.PropertyName) =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
const properties = (node: ts.Node | undefined) =>
  new Map(
    node && ts.isObjectLiteralExpression(node)
      ? node.properties.flatMap((property) =>
          ts.isPropertyAssignment(property)
            ? [[propertyName(property.name), property.initializer] as const]
            : [],
        )
      : [],
  );

function declaredScenarios(source: string) {
  const file = ts.createSourceFile("test-plan.ts", source, ts.ScriptTarget.Latest, true);
  const scenarios = new Map<string, { file: string; title: string; targets: string[] }>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(file) === "scenarios" &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(file) === "plan"
    ) {
      for (const [key, entry] of properties(node.initializer.arguments[0])) {
        const fields = properties(entry),
          path = fields.get("file"),
          title = fields.get("title");
        if (key && path && title && ts.isStringLiteral(path) && ts.isStringLiteral(title))
          scenarios.set(key, {
            file: path.text,
            title: title.text,
            targets: [...properties(fields.get("targets"))].flatMap(([target, value]) =>
              target && ts.isIdentifier(value) && value.text === "scheduled" ? [target] : [],
            ),
          });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return scenarios;
}

function implementsScenario(source: string, key: string) {
  const file = ts.createSourceFile("scenario.ts", source, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "effect" &&
      node.expression.expression.getText(file) === "it" &&
      node.arguments.length >= 2 &&
      node.arguments[0]!.getText(file) === `scenarios.${key}.title` &&
      (ts.isArrowFunction(node.arguments[1]!) || ts.isFunctionExpression(node.arguments[1]!))
    )
      found = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

// Only literal selectors in required steps establish coverage. Indirect or computed
// commands need an explicit verifier before a contract can rely on them.
function runsScenario(job: Record<string, unknown>, proof: Proof, title: string) {
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
      if (match[1] !== proof.target || /\$[a-zA-Z{(]|`/.test(match[3]!)) return false;
      try {
        return new RegExp(match[3]!).test(title);
      } catch {
        return false;
      }
    });
  });
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
  const workflow = parseDocument(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"), {
    uniqueKeys: true,
  });
  if (workflow.errors.length) return ["Invalid CI workflow YAML"];
  const data: unknown = workflow.toJSON();
  if (
    !object(data) ||
    !object(data.jobs) ||
    !object(data.jobs.check) ||
    !Array.isArray(data.jobs.check.needs)
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
          !runsScenario(job, proof, scenario.title)
        )
          errors.push(`${label}: required CI job does not run this scenario`);
      }
  }
  return errors;
}
