import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { testInventory } from "./e2e-inventory.ts";
import { scriptCoverage } from "./e2e-script-coverage.ts";
import { activeSteps, shellCommands, expandedRuns, type Workflow } from "./e2e-workflow.ts";
import type { readDeclarations } from "./declarations.ts";
import type { filesForTarget as targetFiles } from "../../.upstream/e2e/test-plan.ts";
import type { Plan } from "./e2e-inventory.ts";

export function coverageInventory(
  root: string,
  declarations: ReturnType<typeof readDeclarations>,
  workflow: Workflow,
  plans: Record<string, Plan>,
  filesForTarget: typeof targetFiles,
  additionalWorkflows: Workflow[] = [],
) {
  const tests = testInventory(root, plans);
  const records: CoverageRecord[] = tests.map((test) => {
    const declaration = declarations.files[test.file];
    const groups = (declaration?.runs[test.key ?? ""] ?? []).filter((id) => {
      const group = declarations.groups[id];
      if (
        !group ||
        test.plan?.file !== test.file ||
        declaration.scenarios[test.key ?? ""]?.title !== test.title
      )
        return false;
      const steps = activeSteps(workflow.jobs[group.job]);
      const invoked = steps.some((step) =>
        expandedRuns(step.run, workflow.jobs[group.job]!).some((run) =>
          shellCommands(run).some((command) => {
            if (group.matrix)
              return (
                command.includes(
                  'bun scripts/ci/run-declared.ts "${{ matrix.group }}" "${{ matrix.file }}"',
                ) &&
                workflow.jobs[group.job]?.strategy?.matrix ===
                  "${{ fromJSON(needs.select.outputs.matrices)['" + group.job + "'] }}"
              );
            const pattern =
              run.includes(`$(node scripts/ci/e2e-pattern.ts ${id})`) ||
              run.includes(`$(node ../scripts/ci/e2e-pattern.ts ${id})`);
            if (command.includes(`bun run e2e:${group.target} --test-name`) && pattern) return true;
            for (const match of command.matchAll(/\bnode (scripts\/[\w./-]+\.ts)/g)) {
              if (step["working-directory"] && step["working-directory"] !== ".") continue;
              if (!existsSync(join(root, match[1]!))) continue;
              const source = readFileSync(join(root, match[1]!), "utf8");
              if (!source.includes(`"e2e:${group.target}"`) || !source.includes('"--test-name"'))
                continue;
              if (
                (group.command &&
                  command.includes(group.command) &&
                  source.includes(`patternForGroup("${id}")`)) ||
                (pattern && /process\.env\.BASALT_(?:SCOPE|ADOPTION)_PROOF_PATTERN/.test(source))
              )
                return true;
            }
            return false;
          }),
        ),
      );
      if (!invoked) return false;
      return filesForTarget(
        group.target,
        "all",
        group.mode,
        `^${test.title!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      ).includes(`e2e/tests/${test.file}`);
    });
    const config = declaration?.config.some(
      (config) =>
        (!config.titles.length || config.titles.includes(test.title ?? "")) &&
        activeSteps(workflow.jobs[config.job]).some((step) =>
          shellCommands(step.run).some(
            (command) =>
              /^(?:bunx|bun x) vitest run /.test(command) &&
              command.includes(`--config e2e/${config.config}`),
          ),
        ) &&
        readFileSync(join(root, ".upstream/e2e", config.config), "utf8").includes(
          `e2e/tests/${test.file}`,
        ),
    );
    return {
      ...test,
      source: `.upstream/e2e/tests/${test.file}`,
      selected: !test.disabled && (groups.length > 0 || config === true),
      groups,
    };
  });
  const allWorkflows = { jobs: { ...workflow.jobs } };
  additionalWorkflows.forEach((item, index) => {
    for (const [id, job] of Object.entries(item.jobs)) allWorkflows.jobs[`${index}:${id}`] = job;
  });
  const { scripts, reached } = scriptCoverage(root, allWorkflows);
  for (const source of scripts) records.push({ id: source, source, selected: reached.has(source) });
  return records.map((record) => ({
    ...record,
    fingerprint: createHash("sha256")
      .update(readFileSync(join(root, record.source)))
      .update("\0" + JSON.stringify(record.plan ?? null))
      .digest("hex"),
  }));
}

export type CoverageRecord = { id: string; source: string; selected: boolean; plan?: Plan };
export type FingerprintedRecord = CoverageRecord & { fingerprint: string };
export type ExceptionGroup = { reason: string; entries: Record<string, string> };

export function coverageErrors(records: FingerprintedRecord[], exceptions: ExceptionGroup[]) {
  const errors = [];
  const allowed = new Map<string, string>();
  for (const group of exceptions) {
    if (typeof group.reason !== "string" || !group.reason.trim())
      errors.push("Every E2E exception group needs a reviewed reason");
    for (const [id, fingerprint] of Object.entries(group.entries)) {
      if (allowed.has(id)) errors.push(`Duplicate E2E exception: ${id}`);
      allowed.set(id, fingerprint);
    }
  }
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) errors.push(`Duplicate E2E test identity: ${record.id}`);
    seen.add(record.id);
    if (record.selected) {
      if (allowed.has(record.id))
        errors.push(`Remove stale E2E exception now selected by CI: ${record.id}`);
    } else if (!allowed.has(record.id)) {
      errors.push(
        `Ungated E2E: ${record.id}. Add it to a CI group/job, or add a reviewed exception with its source fingerprint and reason.`,
      );
    } else if (allowed.get(record.id) !== record.fingerprint) {
      errors.push(
        `Changed E2E exception needs re-review: ${record.id}. Add it to a CI group/job, or review and update the source fingerprint and reason.`,
      );
    }
  }
  for (const id of allowed.keys())
    if (!seen.has(id)) errors.push(`Remove deleted E2E exception: ${id}`);
  return errors;
}
