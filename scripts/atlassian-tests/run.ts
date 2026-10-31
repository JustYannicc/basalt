import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";

type AtlassianProofInput = {
  readonly root: string;
  readonly upstream: string;
  readonly commit: string;
};

const frozenSourceHash = "2163c3cda99bc3ad267e7042946f6340138deca8ce83c02e2213a9172c9e8347";

async function run(
  command: string,
  args: string[],
  cwd: string,
  log: string,
  home: string,
): Promise<string> {
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TMPDIR: join(home, "tmp"),
    LANG: "en_US.UTF-8",
    NO_COLOR: "1",
    ATLASSIAN_PROTECTED_HOME: homedir(),
    ...(process.env.ATLASSIAN_SPEC_GUARD_NEGATIVE_CONTROL === "1"
      ? { ATLASSIAN_SPEC_GUARD_NEGATIVE_CONTROL: "1" }
      : {}),
    ...(process.env.ATLASSIAN_APPROVAL_NEGATIVE_CONTROL === "1"
      ? { ATLASSIAN_APPROVAL_NEGATIVE_CONTROL: "1" }
      : {}),
    ...(process.env.ATLASSIAN_SPEC_DIRECTORY
      ? { ATLASSIAN_SPEC_DIRECTORY: process.env.ATLASSIAN_SPEC_DIRECTORY }
      : {}),
  };
  const child = spawn(command, args, {
    cwd,
    env: environment,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {}
  }, 10 * 60_000);
  const kill = setTimeout(
    () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    },
    10 * 60_000 + 5000,
  );
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    await writeFile(log, JSON.stringify({ code, timedOut, stdout, stderr }), { mode: 0o600 });
    if (timedOut || code !== 0)
      throw new Error("Atlassian proof failed; private diagnostics remain in its run directory.");
    return stdout;
  } finally {
    clearTimeout(timeout);
    clearTimeout(kill);
  }
}

/** Public self-host runtime, actual catalog source, local Atlassian provider fixture and native MCP clients. */
export async function runAtlassianProof({ root, upstream, commit }: AtlassianProofInput): Promise<{
  readonly checks: number;
  readonly nativeClients: number;
}> {
  if (!root || !upstream || !commit) throw new Error("Prepared runtime inputs are required.");
  const expectedSourceHash = process.env.ATLASSIAN_EXPECTED_SOURCE_SHA256 ?? "";
  if (!/^[a-f0-9]{64}$/.test(expectedSourceHash))
    throw new Error(
      "Set ATLASSIAN_EXPECTED_SOURCE_SHA256 to the expected frozen snapshot hash before proof.",
    );
  if (expectedSourceHash !== frozenSourceHash)
    throw new Error(
      `ATLASSIAN_EXPECTED_SOURCE_SHA256 must match the immutable served snapshot ${frozenSourceHash}.`,
    );
  const snapshot = await readFile(join(root, "src/catalog/atlassian/source.json"));
  const actualSourceHash = createHash("sha256").update(snapshot).digest("hex");
  if (actualSourceHash !== expectedSourceHash)
    throw new Error(
      `Atlassian catalog snapshot hash mismatch: expected ${expectedSourceHash}, found ${actualSourceHash}.`,
    );
  for (const path of ["host.json", "apps.tgz", "npm"]) {
    await access(join(upstream, ".local/test-runtime", path)).catch(() => {
      throw new Error(
        "Atlassian proof prerequisite missing: run heavy-slot bun run e2e:prepare in the prepared upstream checkout.",
      );
    });
  }
  const runs = join(root, ".generated/atlassian-proof");
  await mkdir(runs, { recursive: true, mode: 0o700 });
  await chmod(runs, 0o700);
  const directory = await mkdtemp(join(runs, "run-"));
  await chmod(directory, 0o700);
  await writeFile(
    join(directory, "proof-input.json"),
    JSON.stringify({
      commit,
      sourceSha256: expectedSourceHash,
      approvalNegativeControl: process.env.ATLASSIAN_APPROVAL_NEGATIVE_CONTROL === "1",
    }),
    { mode: 0o600 },
  );
  const home = join(directory, "home");
  await mkdir(join(home, "tmp"), { recursive: true, mode: 0o700 });
  const require = createRequire(join(upstream, "package.json"));
  const { chromium } = require("playwright") as { chromium: { executablePath(): string } };
  const browser = chromium.executablePath();
  await access(browser);
  const output = await run(
    "bun",
    [
      join(root, "scripts/atlassian-tests/runtime.mjs"),
      root,
      upstream,
      directory,
      browser,
      expectedSourceHash,
    ],
    upstream,
    join(directory, "runtime.json"),
    home,
  );
  const report = output
    .split(/\r?\n/)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .find((value) => value?.actualCatalogApp === "atlassian" && value?.syntheticProvider === true);
  if (
    !report ||
    typeof report.checks !== "number" ||
    !report.nativeClients ||
    typeof report.nativeClients !== "object"
  )
    throw new Error("Atlassian runtime proof did not report full completion.");
  console.log(JSON.stringify(report));
  const nativeClients = Object.values(
    report.nativeClients as Record<string, { status?: string }>,
  ).filter((client) => client.status === "passed").length;
  return { checks: report.checks, nativeClients };
}
