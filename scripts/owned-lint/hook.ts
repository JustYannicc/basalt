// The post-edit hook for Claude Code and Codex. It checks the files an agent just edited the way
// the fast lane will (oxfmt, upstream oxlint, then the owned rules), so a finding comes back in
// the same loop instead of at the pull request check. Exit 2 hands the findings back to the
// agent; exit 1 says the hook itself could not run a step, which neither harness treats as a
// finding to fix.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { styleSteps, styled, type StyleStep } from "../ci/style-steps.ts";
import { checkFiles, inScope } from "./check.ts";

const HOOK = "scripts/owned-lint/hook.ts";
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
// Codex edits through apply_patch, whose patch text names each file it writes.
const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gmu;
// Claude Code stops a hook after 60 s by default; finishing first lets this say which step hung.
const BUDGET_MS = 50_000;

type Payload = {
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: { file_path?: unknown; command?: unknown };
};
type Outcome = { failure?: string; crash?: string };
const text = (value: unknown): value is string => typeof value === "string";
const remaining = (deadline: number) => Math.max(1, deadline - Date.now());

/** The absolute paths an edit payload names, as the harness wrote them. */
function editedPaths(payload: Payload) {
  const base = text(payload.cwd) ? payload.cwd : process.cwd();
  const { file_path: file, command } = payload.tool_input ?? {};
  const named =
    payload.tool_name === "apply_patch"
      ? [...(text(command) ? command : "").matchAll(PATCH_FILE)].map(([, path]) => path!.trim())
      : [text(file) ? file : ""];
  return named.flatMap((path) => (path === "" ? [] : [resolve(base, path)]));
}

/** The repository-relative source files an edit payload names. */
export function editedFiles(payload: Payload, repository = root) {
  const files = editedPaths(payload).flatMap((path) => {
    // A checkout reached through a symbolic link names the same files under another path.
    const file = relative(repository, existsSync(path) ? realpathSync(path) : path);
    return !file.startsWith("..") && styled(file) ? [file] : [];
  });
  return [...new Set(files)].sort();
}

/** Runs one step; a step that could not start or finish is a failure of the hook, not the edit. */
export function runStep({ label, command, args, cwd }: StyleStep, deadline: number): Outcome {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: remaining(deadline),
  });
  if (result.error || result.status === null) {
    const hint = existsSync(command) ? "" : "; prepare the checkout with npm run prepare:upstream";
    return {
      crash: `${label} could not run (${result.error?.message ?? `stopped by ${result.signal}`})${hint}.`,
    };
  }
  const output = `${result.stdout}${result.stderr}`.trim();
  return result.status === 0 ? {} : { failure: `${label}:\n${output}` };
}

/** The owned rules in this process, so their oxlint run stops at the hook's own deadline. */
function ownedLint(files: readonly string[], deadline: number): Outcome {
  try {
    const { problems } = checkFiles(files, remaining(deadline));
    return problems.length ? { failure: `owned lint:\n${problems.join("\n")}` } : {};
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { crash: `owned lint could not run (${reason}).` };
  }
}

/** Findings block the agent with exit 2; a step that could not run is reported with exit 1. */
export function verdict(outcomes: readonly Outcome[]) {
  const failures = outcomes.flatMap(({ failure }) => (failure === undefined ? [] : [failure]));
  const crashes = outcomes.flatMap(({ crash }) => (crash === undefined ? [] : [crash]));
  if (failures.length)
    return {
      exit: 2,
      message: `The fast lane would fail on this edit. Fix these before moving on (rules: scripts/owned-lint/README.md):\n\n${[...failures, ...crashes].join("\n\n")}`,
    };
  if (crashes.length)
    return { exit: 1, message: `The post-edit lint hook did not finish:\n${crashes.join("\n")}` };
  return { exit: 0, message: "" };
}

/** The checkout an edited file lives in, when it is not this one: it runs its own hook. */
export function otherCheckout(paths: readonly string[], self = root) {
  const first = paths.find((path) => existsSync(path));
  if (first === undefined) return undefined;
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dirname(realpathSync(first)),
    encoding: "utf8",
  });
  const top = result.status === 0 ? realpathSync(result.stdout.trim()) : undefined;
  return top !== undefined && top !== realpathSync(self) && existsSync(join(top, HOOK))
    ? top
    : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = readFileSync(0, "utf8");
  const payload: Payload = input.trim() === "" ? {} : JSON.parse(input);
  // Claude Code keeps running the main checkout's hook after a session enters a worktree.
  const checkout = otherCheckout(editedPaths(payload));
  if (checkout !== undefined) {
    const result = spawnSync(process.execPath, [join(checkout, HOOK)], {
      input,
      stdio: ["pipe", "inherit", "inherit"],
    });
    process.exit(result.status ?? 1);
  }
  // A patch's moved-from path is gone, and the owned check refuses a missing file.
  const files = editedFiles(payload).filter((file) => existsSync(join(root, file)));
  if (!files.length) process.exit(0);
  const deadline = Date.now() + BUDGET_MS;
  // Formatting is mechanical, so it is applied rather than reported.
  const outcomes = styleSteps(files, { write: true }).map((step) => runStep(step, deadline));
  const owned = files.filter(inScope);
  if (owned.length) outcomes.push(ownedLint(owned, deadline));
  const { exit, message } = verdict(outcomes);
  if (message) console.error(message);
  process.exit(exit);
}
