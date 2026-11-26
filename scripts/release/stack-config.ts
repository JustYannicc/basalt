import { relative, resolve } from "node:path";

/**
 * The stacks the entry deploys or destroys, relative to the repository root, each with the stages
 * it may run on. The entry refuses any other stage before it loads an environment or reads
 * anything: a stack's own stage check runs only once the stack is evaluated, after both.
 */
export const stackStages: ReadonlyArray<readonly [config: string, stages: RegExp]> = [
  ["alchemy.run.ts", /^(?:production|test-[a-z0-9-]+)$/u],
  ["scripts/preview/stack/alchemy.database.ts", /^test-pr-[1-9][0-9]*$/u],
  ["scripts/preview/stack/alchemy.cleanup.ts", /^test-pr-[1-9][0-9]*$/u],
  ["scripts/preview/stack/alchemy.rehearsal-fixture.ts", /^test-rehearsal-[1-9]$/u],
  // The load proof's emulated model upstream, stage test-emulated-upstream, with runner-local state.
  ["scripts/emulated-upstream/stack.ts", /^test-emulated-upstream$/u],
];
export const stackConfigs: ReadonlyArray<string> = stackStages.map(([config]) => config);

/** Whether a known stack may run on a stage; the scale stack keeps its own `scale-<n>` rule. */
export const stackRunsOn = (config: string, stage: string) =>
  stackStages.some(([known, stages]) => known === config && stages.test(stage));

/**
 * The stack a `--config` names: one of the known stacks, relative to the working directory (the
 * cloud app, as previews call it) or the repository root. The scale test deploys a frozen
 * candidate with this checkout's scale stack, matched by its path suffix. Anything else refuses.
 */
export function stackConfig(value: string | undefined, root: string, cwd: string) {
  if (!value) return { config: "alchemy.run.ts", scaleStack: false };
  const known = [relative(root, resolve(cwd, value)), relative(root, resolve(root, value))].find(
    (path) => stackConfigs.includes(path),
  );
  if (known) return { config: known, scaleStack: false };
  const absolute = resolve(cwd, value);
  if (absolute.endsWith("/scripts/scale-test/stack.ts"))
    return { config: absolute, scaleStack: true };
  throw new Error(`Unknown stack config ${value}`);
}
