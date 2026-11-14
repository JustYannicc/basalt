import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rebuildInput, pinPreparation, verifyGeneration } from "./input.ts";
import { hashManifest } from "./manifest.ts";

const temporary = process.env.RUNNER_TEMP ?? "";
const workspace = process.env.GITHUB_WORKSPACE ?? "";
const controller = join(temporary, "framework-rebuild-controller");
const output = join(temporary, "framework-rebuild-hashes");
let phase = "validation";

try {
  if (
    !temporary ||
    !workspace ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    process.env.GITHUB_REF !== "refs/heads/main"
  )
    throw new Error("manual main dispatch required");
  const input = rebuildInput(process.env);
  if (process.argv[2] === "stage") {
    mkdirSync(controller, { mode: 0o700 });
    cpSync(dirname(fileURLToPath(import.meta.url)), controller, { recursive: true });
    writeFileSync(join(controller, "controller-commit"), process.env.GITHUB_SHA ?? "", {
      mode: 0o600,
    });
    console.log("Historical framework rebuild inputs validated.");
  } else if (process.argv[2] === "build") {
    mkdirSync(output, { mode: 0o700 });
    const logs = join(temporary, "framework-rebuild-logs");
    mkdirSync(logs, { mode: 0o700 });
    const execute = (command: string, args: string[], cwd: string) => {
      const log = openSync(join(logs, `${phase}.log`), "a", 0o600);
      try {
        const result = spawnSync(command, args, {
          cwd,
          stdio: ["ignore", log, log],
          env: { ...process.env, BASALT_CI_OMIT_RELEASE_DOWNLOADS: "false" },
        });
        if (result.status !== 0) throw new Error("framework command failed");
      } finally {
        closeSync(log);
      }
    };
    const git = (root: string, args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      if (result.status !== 0) throw new Error("historical Git state unavailable");
      return result.stdout.trim();
    };
    if (process.platform !== "linux" || process.arch !== "x64" || process.version !== "v24.18.0")
      throw new Error("logged Linux x64 Node toolchain required");
    const release = readFileSync("/etc/os-release", "utf8");
    const ubuntu = /^ID=ubuntu$/m.test(release) && /^VERSION_ID="([\d.]+)"$/m.exec(release)?.[1];
    if (`ubuntu-${ubuntu}` !== input.runner) throw new Error("logged Ubuntu version differs");
    const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
    if (bun.status !== 0 || bun.stdout.trim() !== input.bun)
      throw new Error("logged Bun version differs");
    if (git(workspace, ["rev-parse", "HEAD"]) !== input.commit)
      throw new Error("checkout commit differs");
    const root = input.checkout === "workspace" ? resolve(workspace) : join(temporary, "candidate");
    phase = "source";
    if (input.checkout === "candidate")
      execute("git", ["worktree", "add", "--detach", root, input.commit], workspace);
    const preparation = pinPreparation(root, input);
    phase = "prepare";
    try {
      execute("npm", ["run", "prepare:upstream"], root);
    } finally {
      preparation.restore();
    }
    const pin: unknown = JSON.parse(readFileSync(join(root, "upstream.json"), "utf8"));
    if (!pin || typeof pin !== "object" || !("commit" in pin) || typeof pin.commit !== "string")
      throw new Error("historical upstream pin missing");
    verifyGeneration(root, input, homedir(), pin.commit);
    if (git(root, ["status", "--porcelain"]) !== "")
      throw new Error("preparation source was not restored");
    phase = "framework-build";
    execute("bun", ["run", "apps:build"], join(root, ".upstream"));
    phase = "framework-package";
    execute("node", ["scripts/build-basalt-framework.ts"], join(root, ".upstream"));
    phase = "hashes";
    const manifest = hashManifest(
      root,
      input,
      readFileSync(join(controller, "controller-commit"), "utf8"),
    );
    writeFileSync(join(output, "hash-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(
      `Framework ${manifest.framework.version} protocol ${manifest.framework.protocol}: ${manifest.framework.serverModuleMapSha256}`,
    );
  } else throw new Error("unknown rebuild command");
} catch {
  const diagnostic: {
    status: string;
    phase: string;
    dependencyKey?: { expected: string; actual: string };
  } = { status: "failed", phase };
  const prepareLog = join(temporary, "framework-rebuild-logs/prepare.log");
  if (phase === "prepare" && existsSync(prepareLog)) {
    const log = readFileSync(prepareLog, "utf8");
    const mismatch =
      /FRAMEWORK_REBUILD_KEY_MISMATCH expected=([a-f0-9]{64}) actual=([a-f0-9]{64})/.exec(log);
    if (mismatch) {
      diagnostic.dependencyKey = { expected: mismatch[1]!, actual: mismatch[2]! };
      console.error(`Dependency key differs: expected ${mismatch[1]}, actual ${mismatch[2]}.`);
    }
  }
  if (temporary && phase !== "validation") {
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "hash-manifest.json"), JSON.stringify(diagnostic, null, 2) + "\n");
  }
  console.error(
    `Historical framework rebuild failed during ${phase}; no bundle or log is uploaded.`,
  );
  process.exitCode = 1;
}
