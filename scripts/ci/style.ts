import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changedInputs } from "./affected.ts";
import { run } from "../process.ts";
import { vendored } from "../owned-lint/vendor.ts";

export type StyleStep = { label: string; command: string; args: string[]; cwd: string };

/**
 * oxfmt and upstream oxlint over the named source files, as the fast lane runs them; the
 * post-edit hook runs the same steps with `write` so formatting is applied instead of reported.
 */
export function styleSteps(root: string, files: readonly string[], write = false) {
  const tool = (name: string) => resolve(root, ".upstream/node_modules/.bin", name);
  const source = files.filter(
    (file) =>
      /\.(?:[cm]?[jt]sx?)$/u.test(file) && existsSync(resolve(root, file)) && !vendored(file),
  );
  return [false, true].flatMap((upstream): StyleStep[] => {
    const group = source.flatMap((file) =>
      file.startsWith(".upstream/") !== upstream
        ? []
        : [upstream ? file.slice(".upstream/".length) : file],
    );
    if (!group.length) return [];
    const cwd = upstream ? resolve(root, ".upstream") : root;
    return [
      { label: "oxfmt", command: tool("oxfmt"), args: write ? group : ["--check", ...group], cwd },
      {
        label: "upstream oxlint",
        command: tool("oxlint"),
        args: ["-c", resolve(root, ".upstream/.oxlintrc.jsonc"), "--deny-warnings", ...group],
        cwd,
      },
    ];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const { inputs } = changedInputs(root, process.env.BASE_SHA ?? "", process.env.HEAD_SHA ?? "");
  for (const step of styleSteps(root, inputs)) run(step.command, step.args, step.cwd);
}
