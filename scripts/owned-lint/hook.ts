// The post-edit hook for Claude Code and Codex. It checks the files an agent just edited the way
// the fast lane will (oxfmt, upstream oxlint, then the owned rules), so a finding comes back in
// the same loop instead of at the pull request check. Exit 2 hands stderr back to the agent.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vendored } from "./check.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const upstreamRoot = join(root, ".upstream");
// The files scripts/ci/style.ts formats and lints.
const SOURCE = /\.(?:[cm]?[jt]sx?)$/u;
// Codex edits through apply_patch, whose patch text names each file it writes.
const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gmu;

type Payload = {
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; command?: string };
};

/** The repository-relative paths an edit payload names. */
export function editedFiles(payload: Payload, repository = root) {
  const base = payload.cwd ?? process.cwd();
  const named =
    payload.tool_name === "apply_patch"
      ? [...(payload.tool_input?.command ?? "").matchAll(PATCH_FILE)].map(([, file]) =>
          file!.trim(),
        )
      : [payload.tool_input?.file_path ?? ""];
  return [
    ...new Set(
      named
        .filter((file) => file !== "")
        .map((file) => relative(repository, resolve(base, file)))
        .filter((file) => !file.startsWith("..") && SOURCE.test(file) && !vendored(file)),
    ),
  ].sort();
}

const tool = (name: string) => join(upstreamRoot, "node_modules/.bin", name);
const run = (label: string, command: string, args: string[], cwd: string) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 60_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return result.status === 0 ? undefined : `${label}:\n${output}`;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = readFileSync(0, "utf8");
  const payload: Payload = input.trim() === "" ? {} : JSON.parse(input);
  const files = editedFiles(payload).filter((file) => existsSync(join(root, file)));
  if (!files.length || !existsSync(tool("oxfmt"))) process.exit(0);
  const failures: string[] = [];
  for (const upstream of [false, true]) {
    const group = files
      .filter((file) => file.startsWith(".upstream/") === upstream)
      .map((file) => (upstream ? file.slice(".upstream/".length) : file));
    if (!group.length) continue;
    const cwd = upstream ? upstreamRoot : root;
    // Formatting is mechanical, so it is applied rather than reported.
    const formatted = run("oxfmt", tool("oxfmt"), group, cwd);
    const linted = run(
      "upstream oxlint",
      tool("oxlint"),
      ["-c", join(upstreamRoot, ".oxlintrc.jsonc"), "--deny-warnings", ...group],
      cwd,
    );
    failures.push(...[formatted, linted].filter((failure) => failure !== undefined));
    if (!upstream) {
      const owned = run(
        "owned lint",
        process.execPath,
        [join(root, "scripts/owned-lint/check.ts"), ...group],
        root,
      );
      if (owned !== undefined) failures.push(owned);
    }
  }
  if (failures.length) {
    console.error(
      `The fast lane would fail on this edit. Fix these before moving on (rules: scripts/owned-lint/README.md):\n\n${failures.join("\n\n")}`,
    );
    process.exit(2);
  }
}
