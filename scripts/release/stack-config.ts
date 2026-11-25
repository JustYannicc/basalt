import { relative, resolve } from "node:path";

/** The stacks the entry deploys or destroys, relative to the repository root. */
export const stackConfigs: ReadonlyArray<string> = [
  "alchemy.run.ts",
  "scripts/preview/stack/alchemy.database.ts",
  "scripts/preview/stack/alchemy.cleanup.ts",
  "scripts/preview/stack/alchemy.rehearsal-fixture.ts",
  // The route proof's scratch stages, test-route-scratch-1 and -2, with runner-local state.
  "scripts/route-scratch/stack.ts",
];

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
