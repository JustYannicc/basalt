import { spawnSync } from "node:child_process";
import { resolve, relative } from "node:path";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export type FastContext = { root: string; base: string; head: string };
export type FastStep = { name: string; command: string; cwd: string; env: Record<string, string> };

function environment(value: unknown, context: FastContext): Record<string, string> {
  if (value === undefined) return {};
  if (!object(value)) throw new Error("Fast environment must be a mapping");
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== "${{ github.token }}")
      .map(([key, entry]) => {
        if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean")
          throw new Error(`Unsupported fast environment value: ${key}`);
        const text = String(entry);
        const known: Record<string, string> = {
          "${{ github.event.pull_request.base.sha || github.event.before }}": context.base,
          "${{ github.event.pull_request.head.sha || github.sha }}": context.head,
          "${{ github.event.pull_request.base.sha }}": context.base,
          "${{ needs.select.outputs.base_sha }}": context.base,
        };
        if (text.includes("${{")) {
          if (!(text in known)) throw new Error(`Unsupported fast environment expression: ${key}`);
          return [key, known[text]!];
        }
        return [key, text];
      }),
  );
}

export function fastPlan(document: unknown, context: FastContext) {
  if (
    !object(document) ||
    !object(document.jobs) ||
    !object(document.jobs.fast) ||
    !Array.isArray(document.jobs.fast.steps)
  )
    throw new Error("CI has no fast job");
  const fast = document.jobs.fast;
  if (!Array.isArray(fast.steps)) throw new Error("CI fast steps must be a list");
  if (
    fast.if !== undefined ||
    fast["continue-on-error"] !== undefined ||
    fast.defaults !== undefined ||
    document.defaults !== undefined
  )
    throw new Error("Unsupported fast job execution settings");
  const env = { ...environment(document.env, context), ...environment(fast.env, context) };
  let nodeVersion: string | undefined, bunVersion: string | undefined;
  const steps: FastStep[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const step of fast.steps) {
    if (!object(step) || step["continue-on-error"] !== undefined || step.shell !== undefined)
      throw new Error("Unsupported fast step execution settings");
    if (step.uses === "actions/upload-artifact@v4" && step.if === "always()") {
      if (typeof step.name !== "string" || !object(step.with) || typeof step.with.path !== "string")
        throw new Error("Fast artifact uploads need a name and path");
      skipped.push({ name: step.name, reason: "artifact upload requires GitHub Actions" });
      continue;
    }
    if (
      step.if !== undefined &&
      step.if !== "needs.select.outputs.full_suite == 'true'" &&
      step.if !== "needs.select.outputs.full_suite != 'true'"
    )
      throw new Error("Unsupported fast step condition");
    if (typeof step.uses === "string") {
      if (step.if !== undefined) throw new Error("Unsupported conditional fast setup action");
      if (step.uses === "actions/checkout@v4") continue;
      if (
        ["./.github/actions/desktop-release-assets", "./.github/actions/setup-actionlint"].includes(
          step.uses,
        )
      ) {
        skipped.push({
          name: "Restore release assets",
          reason: "download cache requires GitHub Actions",
        });
        continue;
      }
      if (!object(step.with)) throw new Error("Fast tool setup needs explicit versions");
      if (step.uses === "actions/setup-node@v4") nodeVersion = String(step.with["node-version"]);
      else if (
        step.uses === "./.github/actions/setup-bun" ||
        step.uses === "oven-sh/setup-bun@v2"
      ) {
        const version = String(step.with["bun-version"]);
        const reference = /^\$\{\{ env\.([A-Z0-9_]+) \}\}$/.exec(version);
        bunVersion = reference ? env[reference[1]!] : version;
      } else throw new Error(`Unsupported fast setup action: ${step.uses}`);
      continue;
    }
    if (
      typeof step.run !== "string" ||
      !step.run.trim() ||
      step.run.includes("ci:fast") ||
      step.run.includes("fast-local.ts") ||
      step.run.includes("${{")
    )
      throw new Error("Unsupported or recursive fast command");
    const directory = step["working-directory"];
    if (directory !== undefined && typeof directory !== "string")
      throw new Error("Invalid fast working directory");
    const cwd = resolve(context.root, directory ?? ".");
    if (relative(context.root, cwd).split(/[\\/]/).includes(".."))
      throw new Error("Fast step escapes checkout");
    const stepEnv = { ...env, ...environment(step.env, context) };
    if (step.if === "needs.select.outputs.full_suite == 'true'") {
      skipped.push({
        name: typeof step.name === "string" ? step.name : step.run.trim(),
        reason: "full lane only",
      });
      continue;
    }
    steps.push({
      name: typeof step.name === "string" ? step.name : step.run.trim(),
      command: step.run,
      cwd,
      env: stepEnv,
    });
  }
  if (
    !steps.length ||
    !nodeVersion ||
    !/^\d+\.\d+\.\d+$/.test(nodeVersion) ||
    !bunVersion ||
    !/^\d+\.\d+\.\d+$/.test(bunVersion)
  )
    throw new Error("Fast job needs checks and exact Node/Bun versions");
  return { nodeVersion, bunVersion, steps, skipped };
}

export function runFastSteps(
  steps: readonly FastStep[],
  env: NodeJS.ProcessEnv,
  execute = (step: FastStep) =>
    spawnSync("bash", ["-eo", "pipefail", "-c", step.command], {
      cwd: step.cwd,
      stdio: "inherit",
      env: { ...env, ...step.env },
    }).status ?? 1,
) {
  for (const step of steps) {
    console.log(`\n${step.name}`);
    const status = execute(step);
    if (status !== 0) return { status, failed: step.name };
  }
  return { status: 0, failed: null };
}
