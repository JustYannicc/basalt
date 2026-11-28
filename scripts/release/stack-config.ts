import { relative, resolve } from "node:path";
import { Data } from "effect";

/**
 * Where a stack's Alchemy State lives: the HTTP State store production and the previews share, or
 * Alchemy's local state (`Alchemy.localState()`), files in the runner's own checkout.
 */
export type StackState = "shared" | "runner-local";

/**
 * The stacks the entry deploys or destroys, relative to the repository root: their State, and the
 * stages each may run on. The entry refuses any other stage before it loads an environment or reads
 * anything: a stack's own stage check runs only once the stack is evaluated, after both.
 */
export const stackConfigs: ReadonlyArray<{
  readonly path: string;
  readonly state: StackState;
  readonly stages: RegExp;
}> = [
  { path: "alchemy.run.ts", state: "shared", stages: /^(?:production|test-[a-z0-9-]+)$/u },
  {
    path: "scripts/preview/stack/alchemy.database.ts",
    state: "shared",
    stages: /^test-pr-[1-9][0-9]*$/u,
  },
  {
    path: "scripts/preview/stack/alchemy.cleanup.ts",
    state: "shared",
    stages: /^test-pr-[1-9][0-9]*$/u,
  },
  {
    path: "scripts/preview/stack/alchemy.rehearsal-fixture.ts",
    state: "shared",
    stages: /^test-rehearsal-[1-9]$/u,
  },
  // The load proof's emulated model upstream, stage test-emulated-upstream.
  {
    path: "scripts/emulated-upstream/stack.ts",
    state: "runner-local",
    stages: /^test-emulated-upstream$/u,
  },
];
/** Whether a known stack may run on a stage; the scale stack keeps its own `scale-<n>` rule. */
export const stackRunsOn = (config: string, stage: string) =>
  stackConfigs.some((stack) => stack.path === config && stack.stages.test(stage));

/**
 * The stack a `--config` names: one of the known stacks, relative to the working directory (the
 * cloud app, as previews call it) or the repository root. The scale test deploys a frozen
 * candidate with this checkout's scale stack, matched by its path suffix; it keeps its State in
 * the runner's files too. Anything else refuses.
 */
export function stackConfig(value: string | undefined, root: string, cwd: string) {
  if (!value) return { config: "alchemy.run.ts", scaleStack: false, state: "shared" as StackState };
  const known = [relative(root, resolve(cwd, value)), relative(root, resolve(root, value))]
    .map((path) => stackConfigs.find((stack) => stack.path === path))
    .find((stack) => stack !== undefined);
  if (known) return { config: known.path, scaleStack: false, state: known.state };
  const absolute = resolve(cwd, value);
  if (absolute.endsWith("/scripts/scale-test/stack.ts"))
    return { config: absolute, scaleStack: true, state: "runner-local" as StackState };
  throw new Error(`Unknown stack config ${value}`);
}

/** A disposable stage: what the entry accepts besides production and the scale stack's stages. */
export const isTestStage = (stage: string) => /^test-[a-z0-9-]+$/u.test(stage);

/**
 * Production's State is the shared store and nothing else: a stack on runner-local State is
 * refused there before anything loads, whatever its stack module says.
 */
export function assertStateStage(state: StackState, stage: string) {
  if (state === "runner-local" && stage === "production")
    throw new Error("A stack on runner-local State never deploys to production");
}

/** The contract version the shared HTTP State store answers. Moving it is a deliberate upgrade. */
export const SHARED_STATE_VERSION = 8;

/** A configured State store the entry will not plan against. Every field is public. */
export class StateStoreRefused extends Data.TaggedError("StateStoreRefused")<{
  readonly check: "state-store";
  readonly rule: "store" | "version";
  readonly why: string;
  readonly fix: string;
}> {}

/**
 * Why the configured State store refuses, if it does. The shared store answers its deployed
 * contract version, pinned here. Alchemy's local state answers the `STATE_STORE_VERSION` the
 * installed Alchemy was built against (`runnerLocal`, imported from Alchemy by the entry, so an
 * upgrade keeps them in step). That version is expected only from Alchemy's local store itself,
 * for a stack admitted on runner-local State, on a test stage. Everything else keeps the pin.
 */
export function stateStoreRefusal(
  store: { readonly id: string; readonly version: number },
  state: StackState,
  stage: string,
  runnerLocal: number,
) {
  if (state === "runner-local" && store.id !== "local")
    return new StateStoreRefused({
      check: "state-store",
      rule: "store",
      why: `The stack is admitted on runner-local State, but its configured store is ${store.id}.`,
      fix: "Admit the stack with the State its module configures (scripts/release/stack-config.ts).",
    });
  const expected =
    state === "runner-local" && isTestStage(stage) ? runnerLocal : SHARED_STATE_VERSION;
  if (store.version !== expected)
    return new StateStoreRefused({
      check: "state-store",
      rule: "version",
      why: `State store version ${store.version}, expected ${expected}.`,
      fix: "Upgrade it deliberately first.",
    });
  return undefined;
}
