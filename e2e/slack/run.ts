import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

type SlackProofInput = {
  readonly root: string;
  readonly upstream: string;
  readonly commit: string;
  readonly installDiagnostic?: boolean;
  readonly callbackDiagnostic?: boolean;
};

async function run(command: string, args: string[], cwd: string, log: string, home: string): Promise<string> {
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TMPDIR: join(home, "tmp"),
    LANG: "en_US.UTF-8",
    NO_COLOR: "1",
    SLACK_PROTECTED_HOME: homedir(),
  };
  const child = spawn(command, args, {
    cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  await writeFile(log, JSON.stringify({ code, stdout, stderr }), { mode: 0o600 });
  if (code !== 0) throw new Error("Slack proof failed; private diagnostics are in its run directory.");
  return stdout;
}

/** Run the copied Slack package through the pinned public self-host runtime. */
export async function runSlackProof({ root, upstream, commit, installDiagnostic = false, callbackDiagnostic = false }: SlackProofInput): Promise<{
  readonly checks: number;
  readonly installDiagnostic?: boolean;
  readonly callbackDiagnostic?: boolean;
}> {
  if (!root || !upstream || !commit) throw new Error("Prepared runtime inputs are required.");
  for (const path of ["host.json", "apps.tgz", "npm"]) {
    await access(join(upstream, ".local/test-runtime", path)).catch(() => {
      throw new Error("Slack proof prerequisite missing: prepare the pinned upstream test runtime with heavy-slot bun run e2e:prepare.");
    });
  }
  await access(join(upstream, ".local/basalt-framework/framework.json")).catch(() => {
    throw new Error("Slack proof prerequisite missing: build the Basalt apps framework with heavy-slot node scripts/build-basalt-framework.ts.");
  });
  const runs = join(root, ".generated/slack-proof");
  await mkdir(runs, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(runs, "run-"));
  const home = join(directory, "home");
  await mkdir(join(home, "tmp"), { recursive: true, mode: 0o700 });
  const { chromium } = createRequire(join(upstream, "package.json"))("playwright") as {
    chromium: { executablePath(): string };
  };
  const browser = chromium.executablePath();
  await access(browser);
  const output = await run("bun", [
    join(root, "e2e/slack/runtime.mjs"), root, upstream, directory, browser,
    ...(installDiagnostic ? ["--install-diagnostic"] : []),
    ...(callbackDiagnostic ? ["--callback-diagnostic"] : []),
  ], upstream, join(directory, "runtime.json"), home);
  const report = output.split(/\r?\n/).map((line) => {
    try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
  }).find((value) => installDiagnostic
    ? value?.installDiagnostic === true
    : callbackDiagnostic
      ? value?.callbackDiagnostic === true
      : value?.catalogOneClickMethod === "user" && value?.sameOrganizationIsolation === true);
  if (!report || typeof report.checks !== "number") throw new Error("Slack runtime proof did not report full completion.");
  if (!installDiagnostic && !callbackDiagnostic
    && (report.installedClaude !== true || report.installedClaudeRead !== true || report.installedClaudePost !== true))
    throw new Error("Slack runtime proof requires installed Claude to read and post through Signalbox.");
  console.log(JSON.stringify(report));
  return {
    checks: report.checks,
    ...(installDiagnostic ? { installDiagnostic: true } : {}),
    ...(callbackDiagnostic ? { callbackDiagnostic: true } : {}),
  };
}
