// The post-edit hook for Claude Code and Codex. It checks the files an agent just edited the way
// the fast lane will (oxfmt, upstream oxlint, then the owned rules), so a finding comes back in
// the same loop instead of at the pull request check. Exit 2 hands the findings back to the
// agent; exit 1 says the hook itself could not run a step, which neither harness treats as a
// finding to fix.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { styleSteps, type StyleStep } from "../ci/style.ts";
import { vendored } from "./vendor.ts";

const HOOK = "scripts/owned-lint/hook.ts";
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
// The files scripts/ci/style.ts formats and lints.
const SOURCE = /\.(?:[cm]?[jt]sx?)$/u;
// Codex edits through apply_patch, whose patch text names each file it writes.
const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gmu;
// Claude Code stops a hook after 60 s by default; finishing first lets this say which step hung.
const BUDGET_MS = 50_000;

export type Payload = {
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: { file_path?: unknown; command?: unknown };
};
const text = (value: unknown): value is string => typeof value === "string";

/** The absolute paths an edit payload names, as the harness wrote them. */
export function editedPaths(payload: Payload) {
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
    return !file.startsWith("..") && SOURCE.test(file) && !vendored(file) ? [file] : [];
  });
  return [...new Set(files)].sort();
}

/** Runs one step; a step that could not start or finish is a failure of the hook, not the edit. */
export function runStep({ label, command, args, cwd }: StyleStep, deadline: number) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: Math.max(1, deadline - Date.now()),
  });
  if (result.error || result.status === null)
    return {
      crash: `${label} could not run (${result.error?.message ?? `stopped by ${result.signal}`}); prepare the checkout with npm run prepare:upstream.`,
    };
  const output = `${result.stdout}${result.stderr}`.trim();
  return result.status === 0 ? {} : { failure: `${label}:\n${output}` };
}

type Outcome = { failure?: string; crash?: string };

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
  const files = editedFiles(payload).filter((file) => existsSync(join(root, file)));
  if (!files.length) process.exit(0);
  const deadline = Date.now() + BUDGET_MS;
  // Formatting is mechanical, so it is applied rather than reported.
  const steps = styleSteps(root, files, true);
  const owned = files.filter((file) => !file.startsWith(".upstream/"));
  // check.ts exits 1 for findings and for a missing install alike, so the install is checked here.
  const installed = existsSync(join(root, "scripts/owned-lint/node_modules/oxlint/bin/oxlint"));
  if (owned.length && installed)
    steps.push({
      label: "owned lint",
      command: process.execPath,
      args: [join(root, "scripts/owned-lint/check.ts"), ...owned],
      cwd: root,
    });
  const outcomes: Outcome[] = steps.map((step) => runStep(step, deadline));
  if (owned.length && !installed)
    outcomes.push({
      crash:
        "owned lint could not run (scripts/owned-lint is not installed); prepare the checkout with npm run prepare:upstream.",
    });
  const { exit, message } = verdict(outcomes);
  if (message) console.error(message);
  process.exit(exit);
}
