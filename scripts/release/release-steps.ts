import { spawn } from "node:child_process";
import { isResolved } from "alchemy/Diff";
import type * as AlchemyPlan from "alchemy/Plan";
import { Data, Effect, Redacted } from "effect";

/**
 * The stack's commands that must run on every release. Keyed on their real inputs, they run in an
 * apply only when those change, so the entry runs them itself, before apply, when the plan has them
 * as noop: the pool size (set and read back the branch's connection limits) and the source
 * namespace's EU check. Matched on the declared command line.
 */
const EVERY_RELEASE = [/^node scripts\/database-pool-budget\.ts$/u, /^node ensure-artifacts\.ts$/u];

export interface ReleaseStep {
  readonly fqn: string;
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Kept apart so a step can be printed or compared without its secrets. */
  readonly secrets: Readonly<Record<string, Redacted.Redacted<string>>>;
  readonly timeoutMs: number;
}

export class ReleaseStepFailed extends Data.TaggedError("ReleaseStepFailed")<{
  readonly check: string;
  readonly why: string;
  readonly fix: string;
  readonly exit: string;
  readonly detail: { readonly stdout: string; readonly stderr: string };
}> {}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const timeoutMs = (value: unknown) => {
  const match = /^(\d+) (second|minute)s?$/u.exec(String(value ?? ""));
  if (!match) return 10 * 60_000;
  return Number(match[1]) * (match[2] === "minute" ? 60_000 : 1_000);
};

/**
 * Every noop every-release command in the plan, with its command line and directory from this
 * checkout's declaration and each env value from the declaration when known, else from the State
 * row the last apply recorded. A value known in neither refuses: the check must not run half-set.
 */
export const everyReleaseSteps = (plan: AlchemyPlan.Plan) =>
  Effect.gen(function* () {
    const steps: ReleaseStep[] = [];
    for (const [fqn, node] of Object.entries(plan.resources)) {
      if (!node || node.action !== "noop") continue;
      const declared = record(node.resource.Props) ? node.resource.Props : {};
      const command = declared.command;
      if (typeof command !== "string" || !EVERY_RELEASE.some((pattern) => pattern.test(command)))
        continue;
      const recordedProps = (node.state as { props?: Record<string, unknown> } | undefined)?.props;
      const declaredEnv = record(declared.env) ? declared.env : {};
      const recordedEnv = record(recordedProps?.env) ? recordedProps.env : {};
      const env: Record<string, string> = {};
      const secrets: Record<string, Redacted.Redacted<string>> = {};
      // The declared keys only: a key State still holds but the declaration dropped is not passed.
      for (const [key, declaredValue] of Object.entries(declaredEnv)) {
        if (declaredValue === undefined) continue;
        const value = isResolved(declaredValue) ? declaredValue : recordedEnv[key];
        if (typeof value === "string") env[key] = value;
        else if (Redacted.isRedacted(value) && typeof Redacted.value(value) === "string")
          secrets[key] = value as Redacted.Redacted<string>;
        else
          return yield* new ReleaseStepFailed({
            check: fqn,
            why: `${key} is known neither from the declaration nor from State, so the check cannot run before apply.`,
            fix: "Apply once so State records it, or settle the input that leaves it unresolved.",
            exit: "not run",
            detail: { stdout: "", stderr: "" },
          });
      }
      const cwd = declared.cwd;
      if (typeof cwd !== "string")
        return yield* new ReleaseStepFailed({
          check: fqn,
          why: "The command's directory is not known before apply.",
          fix: "Declare the command with a literal directory.",
          exit: "not run",
          detail: { stdout: "", stderr: "" },
        });
      steps.push({ fqn, command, cwd, env, secrets, timeoutMs: timeoutMs(declared.timeout) });
    }
    return steps;
  });

/** Runs one step as Alchemy runs a Command.Exec: the command split on whitespace, no shell. */
export const runReleaseStep = (step: ReleaseStep, inherited: NodeJS.ProcessEnv = process.env) =>
  Effect.callback<void, ReleaseStepFailed>((resume) => {
    const [program, ...args] = step.command.split(/\s+/u);
    const child = spawn(program!, args, {
      cwd: step.cwd,
      env: {
        ...inherited,
        ...step.env,
        ...Object.fromEntries(
          Object.entries(step.secrets).map(([key, value]) => [key, Redacted.value(value)]),
        ),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), step.timeoutMs);
    const failed = (exit: string) =>
      new ReleaseStepFailed({
        check: step.fqn,
        why: "A check the stack runs on every release failed before anything was applied.",
        fix: "Read its output in the private detail; nothing has been applied.",
        exit,
        detail: {
          stdout: Buffer.concat(stdout).toString().slice(-20_000),
          stderr: Buffer.concat(stderr).toString().slice(-20_000),
        },
      });
    child.on("error", () => {
      clearTimeout(timer);
      resume(Effect.fail(failed("not started")));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resume(
        code === 0
          ? Effect.void
          : Effect.fail(failed(signal ? `signal ${signal}` : `exit ${code}`)),
      );
    });
  });
