import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vendored } from "../owned-lint/vendor.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

export type StyleStep = { label: string; command: string; args: string[]; cwd: string };

/** The source the fast lane formats and lints with upstream's tools; vendored copies stay upstream's. */
export const styled = (file: string) => /\.(?:[cm]?[jt]sx?)$/u.test(file) && !vendored(file);

/**
 * oxfmt and upstream oxlint over the named files, as the fast lane runs them. The post-edit
 * hook runs the same steps with `write`, so formatting is applied instead of reported.
 */
export function styleSteps(files: readonly string[], { write = false } = {}) {
  const tool = (name: string) => join(root, ".upstream/node_modules/.bin", name);
  const source = files.filter((file) => styled(file) && existsSync(join(root, file)));
  return [false, true].flatMap((upstream): StyleStep[] => {
    const group = source.flatMap((file) =>
      file.startsWith(".upstream/") !== upstream
        ? []
        : [upstream ? file.slice(".upstream/".length) : file],
    );
    if (!group.length) return [];
    const cwd = upstream ? join(root, ".upstream") : root;
    return [
      { label: "oxfmt", command: tool("oxfmt"), args: write ? group : ["--check", ...group], cwd },
      {
        label: "upstream oxlint",
        command: tool("oxlint"),
        args: ["-c", join(root, ".upstream/.oxlintrc.jsonc"), "--deny-warnings", ...group],
        cwd,
      },
    ];
  });
}
