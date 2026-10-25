import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appConfig } from "./config.mjs";

const oxlint = fileURLToPath(new URL("./node_modules/oxlint/bin/oxlint", import.meta.url));

export function lintApp(files) {
  const scratch = mkdtempSync(join(tmpdir(), "executor-app-lint-"));
  try {
    const names = [];
    for (const file of files) {
      if (!/\.[cm]?[jt]sx?$/.test(file.path) || file.path.startsWith("ui/public/")) continue;
      const path = join(scratch, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.bytes);
      names.push(file.path);
    }
    if (!names.length) return [];
    const config = join(scratch, ".oxlintrc.json");
    writeFileSync(config, JSON.stringify(appConfig()));
    const result = spawnSync(
      process.execPath,
      [oxlint, "--config", config, "--no-ignore", "--threads", "2", "--format", "json", "."],
      {
        cwd: scratch,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (result.error) throw result.error;
    if (result.status === null) throw new Error(`Oxlint terminated: ${result.signal}`);
    if (result.status === 0) return [];
    let output;
    try {
      output = JSON.parse(result.stdout);
    } catch {
      throw new Error(`Oxlint failed: ${result.stderr || result.stdout}`);
    }
    if (!output.diagnostics?.length)
      throw new Error(`Oxlint failed without diagnostics: ${result.stderr || result.stdout}`);
    return output.diagnostics.map((diagnostic) => {
      const location = diagnostic.labels?.[0]?.span;
      return `${diagnostic.filename ?? ""}:${location?.line ?? 1}: ${diagnostic.code ?? "oxlint"}: ${diagnostic.message}`;
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
