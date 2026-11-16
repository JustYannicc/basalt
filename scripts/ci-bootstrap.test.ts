import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, win32 } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { actionlintSource } from "./ci/actionlint.ts";
import { downloadVerified } from "./ci/verified-download.mjs";

test("verified cache hits make no request, and corrupt archives fail before use", () => {
  const root = mkdtempSync(join(tmpdir(), "basalt-archive-cache-"));
  try {
    const archive = join(root, "archive");
    writeFileSync(archive, "fixture bytes");
    const integrity = "sha256-" + createHash("sha256").update("fixture bytes").digest("base64");
    downloadVerified("https://release-assets-blocked.invalid/archive", integrity, archive);
    writeFileSync(archive, "corrupted");
    assert.throws(
      () => downloadVerified("https://release-assets-blocked.invalid/archive", integrity, archive),
      /checksum mismatch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("actionlint cold population uses pinned Go source and fast requires the warmed cache", () => {
  assert.equal(new URL(actionlintSource.url).host, "proxy.golang.org");
  assert.match(actionlintSource.sha256, /^[a-f0-9]{64}$/);
  const launcher = readFileSync(new URL("./ci/check-workflows.ts", import.meta.url), "utf8");
  assert.doesNotMatch(launcher, /github\.com.*releases\/download/);
  const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const action = "./.github/actions/setup-actionlint";
  assert.ok(workflow.jobs.select.steps.some((step: { uses?: string }) => step.uses === action));
  assert.equal(
    workflow.jobs.fast.steps.find((step: { uses?: string }) => step.uses === action).with[
      "require-hit"
    ],
    "true",
  );
  assert.equal(workflow.jobs.fast.needs, "select");
});

test("Check toolchain bootstraps use official non-GitHub sources on every runner", async () => {
  const { bunAsset } = await import("./ci/setup-bun.ts");
  for (const version of ["1.4.2", "1.4.4"])
    for (const platform of [
      "linux-x64",
      "linux-arm64",
      "darwin-x64",
      "darwin-arm64",
      "win32-x64",
    ]) {
      const asset = bunAsset(version, platform);
      assert.equal(new URL(asset.url).host, "registry.npmjs.org");
      assert.match(asset.integrity, /^sha512-/);
      assert.ok(asset.key.includes(version) && asset.key.includes(platform));
    }
  assert.throws(() => bunAsset("unlisted"), /No checksum-pinned Bun/);
  const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  for (const id of Object.keys(workflow.jobs)) {
    for (const step of workflow.jobs[id].steps) {
      assert.ok(!step.uses?.startsWith("oven-sh/setup-bun@"), id);
      assert.ok(!step.uses?.startsWith("actions/setup-node@"), id);
    }
  }
});

test("Node bootstrap reads only pinned official archives and refuses unknown versions", async () => {
  const { nodeAsset } = await import("./ci/setup-node.mjs");
  for (const platform of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"]) {
    const asset = nodeAsset("24.18.0", platform);
    assert.equal(asset.url, `https://nodejs.org/dist/v24.18.0/${asset.file}`);
    assert.match(asset.integrity, /^sha256-/);
    assert.match(asset.key, /node-dist-v1-24\.18\.0-.*[a-f0-9]{64}$/);
  }
  assert.throws(() => nodeAsset("unknown"), /No checksum-pinned Node/);
  assert.throws(() => nodeAsset("24.18.0", "unknown"), /No checksum-pinned Node/);
  const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  for (const id of ["select", "fast", "workerd-assets", "check", "client-desktop"])
    assert.ok(
      workflow.jobs[id].steps.some(
        (step: { uses?: string }) => step.uses === "./.github/actions/setup-node",
      ),
      id,
    );
});

test("Windows toolchain archives bypass PATH tar for drive-letter paths", async () => {
  const { archiveTar } = await import("./ci/verified-download.mjs");
  const windows = archiveTar("win32");
  assert.equal(win32.isAbsolute(windows), true);
  assert.equal(
    windows,
    win32.join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", "tar.exe"),
  );
  assert.notEqual(windows, "tar");
  for (const platform of ["linux", "darwin"]) assert.equal(archiveTar(platform), "tar");
});

test("Bun setup exposes both command entry points on Unix and Windows and can repeat", async () => {
  const { bunEntrypoints } = await import("./ci/setup-bun.ts");
  const platforms: NodeJS.Platform[] = ["linux", "win32"];
  for (const platform of platforms) {
    const root = mkdtempSync(join(tmpdir(), "basalt-bun-commands-"));
    try {
      const binary = join(root, platform === "win32" ? "bun.exe" : "bun");
      writeFileSync(binary, "installed Bun binary");
      const commands = bunEntrypoints(root, platform);
      for (const command of Object.values(commands)) {
        assert.equal(statSync(command).isFile(), true);
        assert.equal(readFileSync(command, "utf8"), "installed Bun binary");
      }
      assert.equal(statSync(commands.bun).ino, statSync(commands.bunx).ino);
      writeFileSync(binary, "updated Bun binary");
      assert.deepEqual(bunEntrypoints(root, platform), commands);
      assert.equal(readFileSync(commands.bunx, "utf8"), "updated Bun binary");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("Bun setup keeps the primary on PATH and exports a named secondary binary only", async () => {
  const { registerBun } = await import("./ci/setup-bun.ts");
  const root = mkdtempSync(join(tmpdir(), "basalt-bun-export-"));
  try {
    const bun = join(root, "bun");
    const pathFile = join(root, "github-path");
    const envFile = join(root, "github-env");
    writeFileSync(bun, "installed Bun binary");
    writeFileSync(pathFile, "existing-path\n");
    writeFileSync(envFile, "existing-env\n");

    registerBun(root, bun, undefined, { GITHUB_PATH: pathFile, GITHUB_ENV: envFile });
    assert.equal(readFileSync(pathFile, "utf8"), `existing-path\n${root}\n`);
    assert.equal(readFileSync(envFile, "utf8"), "existing-env\n");

    registerBun(root, bun, "EXECUTOR_MOTEL_BUN", {
      GITHUB_PATH: pathFile,
      GITHUB_ENV: envFile,
    });
    assert.equal(readFileSync(pathFile, "utf8"), `existing-path\n${root}\n`);
    assert.equal(readFileSync(envFile, "utf8"), `existing-env\nEXECUTOR_MOTEL_BUN=${bun}\n`);
    assert.throws(
      () =>
        registerBun(root, bun, "GITHUB_PATH", {
          GITHUB_PATH: pathFile,
          GITHUB_ENV: envFile,
        }),
      /non-reserved environment variable name/,
    );
    assert.throws(
      () => registerBun(root, bun, "EXECUTOR_MOTEL_BUN", { GITHUB_PATH: pathFile }),
      /GITHUB_ENV/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every workflow job preparing upstream E2E assets gets the separate collector Bun", () => {
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const workflowRoot = join(repositoryRoot, ".github/workflows");
  const scriptsRoot = join(repositoryRoot, "scripts");
  const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
  const action = parse(
    readFileSync(join(repositoryRoot, ".github/actions/setup-bun/action.yml"), "utf8"),
  );
  assert.equal(action.inputs["export-as"].required, false);
  const filesBelow = (root: string): string[] =>
    readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory() && ["node_modules", ".git"].includes(entry.name)) return [];
      const path = join(root, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    });
  const prepareWrappers = filesBelow(scriptsRoot)
    .filter((path) => /\.[cm]?[jt]sx?$/.test(path))
    .filter((path) =>
      /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*["']bun["']\s*,\s*\[[^\]]*["']e2e:prepare["']/.test(
        readFileSync(path, "utf8"),
      ),
    )
    .map((path) => relative(repositoryRoot, path).replaceAll("\\", "/"));
  const setupBun = "./.github/actions/setup-bun";
  let coveredJobs = 0;

  const workflowFiles = readdirSync(workflowRoot).filter((name) => /\.ya?ml$/.test(name));
  let primaryWorkflowVersion: string | undefined;
  for (const file of workflowFiles) {
    const workflow = parse(readFileSync(join(workflowRoot, file), "utf8"));
    if (file === "ci.yml") primaryWorkflowVersion = workflow.env?.E2E_BUN_VERSION;
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      const steps =
        (
          job as {
            steps?: Array<{ uses?: string; with?: Record<string, string>; run?: string }>;
          }
        ).steps ?? [];
      const callerIndexes = steps.flatMap((step, index) => {
        const run = step.run ?? "";
        return /\be2e:prepare(?=$|\s)/.test(run) ||
          prepareWrappers.some((path) => run.includes(path))
          ? [index]
          : [];
      });
      if (callerIndexes.length === 0) continue;
      coveredJobs += 1;

      const primaryIndex = steps.findIndex(
        (step) =>
          (step.uses === setupBun &&
            step.with?.["bun-version"] === "${{ env.E2E_BUN_VERSION }}" &&
            step.with?.["export-as"] === undefined) ||
          (step.uses === "oven-sh/setup-bun@v2" && step.with?.["bun-version"] === "1.4.2"),
      );
      const collectorIndex = steps.findIndex(
        (step) =>
          step.uses === setupBun &&
          step.with?.["bun-version"] === "1.4.4" &&
          step.with?.["export-as"] === "EXECUTOR_MOTEL_BUN",
      );
      const callerIndex = Math.min(...callerIndexes);
      assert.ok(
        primaryIndex >= 0 && primaryIndex < collectorIndex,
        `${file}:${name} primary Bun setup`,
      );
      assert.ok(collectorIndex < callerIndex, `${file}:${name} collector setup`);
    }
  }

  assert.equal(primaryWorkflowVersion, "1.4.2");
  assert.ok(coveredJobs > 0);
});
