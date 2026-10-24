import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

type ConnectorsProofInput = {
  readonly root: string;
  readonly upstream: string;
  readonly commit: string;
};

async function run(command: string, args: string[], cwd: string, log: string): Promise<string> {
  const child = spawn(command, args, {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: homedir(), TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "en_US.UTF-8", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((done, fail) => { child.once("error", fail); child.once("close", done); });
  await writeFile(log, JSON.stringify({ code, stdout, stderr }), { mode: 0o600 });
  if (code !== 0) throw new Error("Connector proof stage failed; private diagnostics retained in the run directory.");
  return stdout;
}

/** Public self-host runtime, published provider emulator, native PATs, and installed Claude. */
export async function runConnectorsProof({ root, upstream, commit }: ConnectorsProofInput): Promise<{ readonly checks: number }> {
  if (!root || !upstream || !commit) throw new Error("Prepared runtime inputs are required.");
  for (const path of ["host.json", "apps.tgz", "npm"]) {
    await access(join(upstream, ".local/test-runtime", path)).catch(() => {
      throw new Error("Connector proof prerequisite missing: run heavy-slot bun run e2e:prepare in the prepared upstream checkout.");
    });
  }
  const runs = join(root, ".generated/connectors-proof");
  await mkdir(runs, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(runs, "run-"));
  const installation = join(directory, "provider");
  await mkdir(installation, { recursive: true, mode: 0o700 });
  await writeFile(join(installation, "package.json"), JSON.stringify({ private: true }), { mode: 0o600 });
  await run(join(homedir(), ".local/bin/heavy-slot"), ["bun", "add", "--cwd", installation,
    "--ignore-scripts", "@executor-js/emulate@0.14.2"],
  root, join(directory, "install.json"));
  const packageRoot = join(installation, "node_modules/@executor-js/emulate");
  const metadata: { version: string; bin: string | Record<string, string> } = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (metadata.version !== "0.14.2") throw new Error("Wrong provider emulator version.");
  const entry = typeof metadata.bin === "string" ? metadata.bin : Object.values(metadata.bin)[0];
  if (!entry) throw new Error("Published emulator CLI missing.");
  const output = await run("bun", [join(root, "scripts/connectors-tests/runtime.mjs"), root, upstream, directory,
    resolve(packageRoot, entry)], upstream, join(directory, "runtime.json"));
  const report = output.split(/\r?\n/).map((line) => {
    try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
  }).find((value) => value?.installedClaude === true && value?.publishedGoogleEmulatorOAuth === true);
  if (!report || typeof report.checks !== "number") throw new Error("Connector runtime proof did not report full completion.");
  console.log(JSON.stringify(report));
  return { checks: report.checks };
}
