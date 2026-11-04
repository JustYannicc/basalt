import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { changedInputs } from "./affected.ts";
import { run } from "../process.ts";

const root = process.cwd();
const { inputs } = changedInputs(root, process.env.BASE_SHA ?? "", process.env.HEAD_SHA ?? "");
const source = inputs.filter((file) => /\.(?:[cm]?[jt]sx?)$/.test(file) && existsSync(file));
for (const upstream of [false, true]) {
  const files = source
    .filter((file) => file.startsWith(".upstream/") === upstream)
    .map((file) => (upstream ? file.slice(".upstream/".length) : file));
  if (!files.length) continue;
  const cwd = upstream ? resolve(root, ".upstream") : root;
  run(resolve(root, ".upstream/node_modules/.bin/oxfmt"), ["--check", ...files], cwd);
  run(
    resolve(root, ".upstream/node_modules/.bin/oxlint"),
    ["-c", resolve(root, ".upstream/.oxlintrc.jsonc"), "--deny-warnings", ...files],
    cwd,
  );
}
