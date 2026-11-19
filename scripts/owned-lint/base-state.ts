// What the base commit held for the ratchet: the gate's own records, its vendored copy, and how
// each file under scripts/ and src/ changed since.
import { execFileSync, spawnSync } from "node:child_process";
import type { Allowlist, BaseState, Config, Counts } from "./baseline.ts";
import { VENDOR, vendorState } from "./vendor.ts";

const GATE = "scripts/owned-lint";
// Changing these may change what the rules find, so a rise against the base is listed for
// review instead of failing; the rule cases in rules.test.ts guard the change.
const LINT_INPUTS = [`${GATE}/plugin`, VENDOR, `${GATE}/package.json`, `${GATE}/bun.lock`];

/** The base commit's state in the checkout at `root`; `outside` names the paths the gate skips. */
export function baseState(root: string, base: string, outside: (file: string) => boolean) {
  if (
    !/^[0-9a-f]{40}$/u.test(base) ||
    spawnSync("git", ["cat-file", "-e", `${base}^{commit}`], { cwd: root }).status !== 0
  )
    throw new Error(`BASE_SHA ${base} is not a commit in this repository.`);
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).split(
      "\0",
    );
  const tracked = new Set(
    git(["ls-tree", "-r", "-z", "--name-only", base, "--", "scripts", "src"]),
  );
  // Absence comes from the base's tree: a failed read must not look absent, which skips the ratchet.
  const showText = (file: string) =>
    tracked.has(file)
      ? execFileSync("git", ["show", `${base}:${file}`], {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        })
      : undefined;
  const show = (file: string) => {
    const text = showText(`${GATE}/${file}`);
    return text === undefined ? undefined : JSON.parse(text);
  };
  // The working tree against the base, with renames: a renamed file keeps its old count.
  const renamed = new Map<string, string>();
  const changed = new Set<string>();
  // Renames from anywhere under scripts/ and src/, so code moved out of the release layer is found.
  const entries = git(["diff", "-z", "--name-status", "-M", base, "--", "scripts", "src"]);
  for (let index = 0; index < entries.length - 1;) {
    const status = entries[index++]!;
    if (status.startsWith("R")) {
      const from = entries[index++]!;
      const to = entries[index++]!;
      renamed.set(to, from);
      changed.add(to);
    } else changed.add(entries[index++]!);
  }
  const lintChanged =
    spawnSync("git", ["diff", "--quiet", base, "--", ...LINT_INPUTS], { cwd: root }).status !== 0;
  // SAFETY: these are the base commit's own gate records, which this gate wrote and read with
  // these shapes in the base's own checked run.
  const records = {
    baseline: show("baseline.json") as Counts | undefined,
    config: show(".oxlintrc.json") as Config | undefined,
    allowlist: (show("allowlist.json") ?? {}) as Allowlist,
  };
  return {
    policy: {
      ...records,
      basePath: (file: string) => renamed.get(file) ?? (tracked.has(file) ? file : undefined),
      enteredScope: (file: string) => outside(renamed.get(file) ?? file),
      changed: (file: string) => changed.has(file) || !tracked.has(file),
      lintChanged,
    } satisfies BaseState,
    vendor: vendorState(showText),
  };
}
