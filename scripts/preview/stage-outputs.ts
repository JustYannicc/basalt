import { fileURLToPath } from "node:url";
import { isRehearsalStage, rehearsalStack } from "../release-barrier/release-stage.ts";
import { rehearsalFixtureStack } from "./subject.ts";

/**
 * The barrier keeps journals and receipts as outputs of `<stack>-<purpose>` stacks, which the
 * stage's own destroy never reaches. A stage's rows there are resources or a stack output, and
 * listing stages sees only resources, so both are checked. Only this rehearsal stage qualifies.
 */
export async function rehearsalOutputStacks(
  stage: string,
  stacks: readonly string[],
  holds: (stack: string) => Promise<boolean>,
): Promise<string[]> {
  if (!isRehearsalStage(stage))
    throw new Error("Stage outputs are removed only for rehearsal stages");
  const present: string[] = [];
  for (const stack of stacks) {
    if (!stack.startsWith(`${rehearsalStack}-`) || stack === rehearsalFixtureStack) continue;
    if (await holds(stack)) present.push(stack);
  }
  return present;
}

async function main(mode: string | undefined, stage: string | undefined) {
  if ((mode !== "delete" && mode !== "verify") || !stage || !isRehearsalStage(stage))
    throw new Error("Usage: stage-outputs.ts delete|verify test-rehearsal-N");
  if (process.env.ALCHEMY_STAGE !== stage) throw new Error("ALCHEMY_STAGE must name the stage");
  const { Cause, ConfigProvider, Effect, Exit, Logger } = await import("effect");
  const { State } = await import("alchemy/State/State");
  const { evalStack } = await import("alchemy/Stack");
  const { releaseStateStack } = await import("../release-barrier/release-state-stack.ts");
  const { withReleaseRuntime } = await import("../release-barrier/runtime.ts");
  const program = evalStack(
    releaseStateStack,
    (compiled) =>
      Effect.gen(function* () {
        const state = yield* yield* State;
        const stacks = yield* state.listStacks();
        const held = new Set<string>();
        for (const stack of stacks) {
          if (!stack.startsWith(`${rehearsalStack}-`)) continue;
          const resources = (yield* state.listStages(stack)).includes(stage);
          const output = (yield* state.getOutput({ stack, stage })) !== undefined;
          if (resources || output) held.add(stack);
        }
        const present = yield* Effect.promise(() =>
          rehearsalOutputStacks(stage, stacks, async (stack) => held.has(stack)),
        );
        if (mode === "verify") {
          if (present.length) return yield* Effect.die(new Error("Rehearsal stage outputs remain"));
          return;
        }
        for (const stack of present) yield* state.deleteStack({ stack, stage });
      }).pipe(Effect.provideContext(compiled.services)),
    { stage },
  );
  const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN } = process.env;
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN)
    throw new Error("Cloudflare credentials are missing");
  const exit = await Effect.runPromiseExit(
    program.pipe(
      withReleaseRuntime,
      Effect.timeout("5 minutes"),
      Effect.provide(Logger.layer([])),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { ALCHEMY_STAGE: stage, CI: "true", CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN },
          }),
        ),
      ),
    ),
  );
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv[2], process.argv[3]);
  } catch {
    console.error("Rehearsal stage output cleanup failed");
    process.exitCode = 1;
  }
}
