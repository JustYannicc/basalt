import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

type ConnectorsProofInput = {
  readonly root: string;
  readonly upstream: string;
  readonly commit: string;
  readonly candidate: string;
  readonly patches: readonly string[];
};

async function run(command: string, args: string[], cwd: string, log: string, home: string, heavy = false): Promise<string> {
  const environment = { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: join(home, "tmp"),
    LANG: "en_US.UTF-8", NO_COLOR: "1", CONNECTORS_PROTECTED_HOME: homedir(),
    CONNECTORS_PROOF_SKIP_CLAUDE: process.env.CONNECTORS_PROOF_SKIP_CLAUDE ?? "" };
  // The slot coordinator uses the machine-wide queue; its actual child receives only this private environment.
  const child = spawn(heavy ? join(homedir(), ".local/bin/heavy-slot") : command,
    heavy ? ["/usr/bin/env", "-i", ...Object.entries(environment).map(([key, value]) => `${key}=${value}`), command, ...args] : args, {
    cwd,
    env: heavy ? { PATH: process.env.PATH ?? "", HOME: homedir(), LANG: "en_US.UTF-8" } : environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((done, fail) => { child.once("error", fail); child.once("close", done); });
  await writeFile(log, JSON.stringify({ code, stdout, stderr }), { mode: 0o600 });
  if (code !== 0) {
    let reported = false;
    for (const line of stderr.split(/\r?\n/)) {
      if (line.startsWith("CONNECTORS_BROWSER_FAILURE ")) {
        try {
          const reason: unknown = JSON.parse(line.slice("CONNECTORS_BROWSER_FAILURE ".length));
          if (typeof reason === "string" && reason.length <= 1500)
            console.error(`CONNECTORS_BROWSER_FAILURE ${JSON.stringify(reason)}`);
        } catch { /* Ignore malformed diagnostic lines. */ }
      }
      if (/^CONNECTORS_PROOF_FAILURE phase=[a-z-]+ kind=[a-z-]+ at=(?:[a-z0-9-]+\.mjs:[0-9]+|unknown)$/.test(line)) {
        console.error(line);
        reported = true;
      }
    }
    if (!reported) {
      const kind = /Cannot find module|Cannot find package|ModuleNotFound|SyntaxError/.test(stderr)
        ? "module-load" : /EACCES|EPERM/.test(stderr) ? "permission" : "process";
      console.error(`CONNECTORS_PROOF_FAILURE phase=process-startup kind=${kind} at=unknown`);
    }
    throw new Error("Connector proof stage failed; private diagnostics retained in the run directory.");
  }
  return stdout;
}

/** Public self-host runtime, published provider emulator, native PATs, and installed Claude. */
export async function runConnectorsProof({ root, upstream, commit, candidate, patches }: ConnectorsProofInput): Promise<{ readonly checks: number }> {
  if (!root || !upstream || !/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(candidate) || patches.length === 0)
    throw new Error("A frozen candidate and prepared runtime inputs are required.");
  for (const path of ["host.json", "apps.tgz", "npm"]) {
    await access(join(upstream, ".local/test-runtime", path)).catch(() => {
      throw new Error("Connector proof prerequisite missing: run heavy-slot bun run e2e:prepare in the prepared upstream checkout.");
    });
  }
  const runs = join(root, ".generated/connectors-proof");
  await mkdir(runs, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(runs, "run-"));
  const home = join(directory, "home");
  await mkdir(join(home, "tmp"), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "proof-input.json"), `${JSON.stringify({
    candidateSha: candidate,
    upstreamPin: commit,
    patches,
  }, null, 2)}\n`, { mode: 0o600 });
  const configuredPin = (JSON.parse(await readFile(join(root, "upstream.json"), "utf8")) as { commit?: unknown }).commit;
  if (configuredPin !== commit) throw new Error("Connector proof input does not match upstream.json.");
  const upstreamHead = await run("git", ["rev-parse", "HEAD"], upstream,
    join(directory, "upstream-head.json"), join(directory, "home"));
  if (upstreamHead.trim() !== commit) throw new Error("Prepared upstream checkout does not match upstream.json.");
  // Reuse the installed browser binary, while Playwright creates its profile under the private HOME/TMPDIR.
  const { chromium } = createRequire(join(upstream, "package.json"))("playwright") as { chromium: { executablePath(): string } };
  const useHeavySlot = process.env.CONNECTORS_PROOF_DIRECT !== "1";
  const browser = chromium.executablePath();
  await access(browser);
  const installation = join(directory, "provider");
  await mkdir(installation, { recursive: true, mode: 0o700 });
  await writeFile(join(installation, "package.json"), JSON.stringify({ private: true }), { mode: 0o600 });
  await run("bun", ["add", "--cwd", installation,
    "--ignore-scripts", "@executor-js/emulate@0.14.2"],
  root, join(directory, "install.json"), home, useHeavySlot);
  const packageRoot = join(installation, "node_modules/@executor-js/emulate");
  const metadata: { version: string; bin: string | Record<string, string> } = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (metadata.version !== "0.14.2") throw new Error("Wrong provider emulator version.");
  const entry = typeof metadata.bin === "string" ? metadata.bin : Object.values(metadata.bin)[0];
  if (!entry) throw new Error("Published emulator CLI missing.");
  const output = await run("bun", [join(root, "scripts/connectors-tests/runtime.mjs"), root, upstream, directory,
    resolve(packageRoot, entry), browser, commit, candidate, JSON.stringify(patches)], upstream,
  join(directory, "runtime.json"), home, useHeavySlot);
  const report = output.split(/\r?\n/).map((line) => {
    try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
  }).find((value) =>
    ((value?.installedClaude === true && value?.installedAgentNativeToolCall === true) ||
      (process.env.CONNECTORS_PROOF_SKIP_CLAUDE === "1"
        && value?.installedClaudeSkipped === true && value?.installedAgentNativeToolCallSkipped === true))
    && value?.publishedGoogleEmulatorOAuth === true
    && value?.testAccountsProvisionedByPinnedCli === true
    && value?.gitlabTwoOriginRuntime === true
    && value?.gitlabHostedClientAtGitLabComOnly === true
    && value?.gitlabLegacyAccountIdPreserved === true
    && value?.gitlabLegacyDefaultSitePersisted === true
    && value?.gitlabLegacyCanonicalDefaultOrigin === true
    && value?.gitlabReconnectOriginLocked === true
    && value?.gitlabPatAndOAuthAccounts === true
    && value?.gitlabPrivateRedirectRefused === true
    && value?.gitlabMutationApprovalPreserved === true
    && value?.gitlabDefaultOriginUi === true
    && value?.zendeskNativeAuthorizationStart === true && value?.zendeskPeerConnectionDenials === 2
    && value?.hostedManagedClientAtExactAccountSite === true
    && value?.hostedManagedClientRotationAtExactAccountSite === true
    && value?.hostedManagedClientPeerHostPlacementDenied === true);
  if (!report || typeof report.checks !== "number") throw new Error("Connector runtime proof did not report full completion.");
  console.log(JSON.stringify(report));
  return { checks: report.checks };
}
