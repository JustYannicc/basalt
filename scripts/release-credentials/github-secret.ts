import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { credentialSecretNames, maxGitHubSecretBytes, secretKillGraceMs, secretWriteTimeoutMs } from "./constants.ts";

const allowedSecretNames = new Set<string>(Object.values(credentialSecretNames));
const safeFailureMessage = "Credential secret update failed.";

export type GitHubSecretWriter = (
  name: string,
  value: string,
  token: string,
  repository: string,
) => Promise<void>;

export class GitHubSecretWriteFailure extends Error {
  constructor() {
    super(safeFailureMessage);
    this.name = "GitHubSecretWriteFailure";
  }
}

export interface GitHubSecretOptions {
  readonly spawnProcess?: typeof spawn;
  readonly path?: string;
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
}

function validRepository(repository: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository);
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  try { child.kill(signal); } catch { /* The bounded wait below still closes the operation. */ }
}

export async function setGitHubSecret(
  name: string,
  value: string,
  token: string,
  repository: string,
  options: GitHubSecretOptions = {},
): Promise<void> {
  if (
    !allowedSecretNames.has(name) || typeof value !== "string" || value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maxGitHubSecretBytes ||
    token.length === 0 || token.length > 8192 || /[\u0000\r\n]/.test(token) ||
    !validRepository(repository)
  ) throw new GitHubSecretWriteFailure();

  const path = options.path ?? process.env.PATH;
  if (!path) throw new GitHubSecretWriteFailure();
  const args = ["secret", "set", name, "--repo", repository];
  let child: ChildProcess;
  try {
    const childEnvironment = { PATH: path, GH_TOKEN: token };
    const spawnOptions: SpawnOptions = {
      env: childEnvironment,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    };
    child = (options.spawnProcess ?? spawn)("gh", args, spawnOptions);
  } catch {
    throw new GitHubSecretWriteFailure();
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let failed = false;
    let stopping = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let hardStopTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (hardStopTimer) clearTimeout(hardStopTimer);
      if (success) resolve();
      else reject(new GitHubSecretWriteFailure());
    };

    const stopChild = () => {
      if (settled || stopping) return;
      stopping = true;
      terminate(child, "SIGTERM");
      killTimer = setTimeout(() => {
        terminate(child, "SIGKILL");
        hardStopTimer = setTimeout(() => finish(false), 1_000);
      }, Math.max(0, options.killGraceMs ?? secretKillGraceMs));
    };

    timeout = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, Math.max(1, options.timeoutMs ?? secretWriteTimeoutMs));

    child.once("error", () => {
      failed = true;
      if (child.pid === undefined || child.pid === null) finish(false);
      else stopChild();
    });
    child.once("close", (code) => finish(!timedOut && !failed && code === 0));
    if (!child.stdin) {
      failed = true;
      stopChild();
    } else {
      child.stdin.once("error", () => {
        failed = true;
        stopChild();
      });
      try {
        child.stdin.end(value, "utf8");
      } catch {
        failed = true;
        stopChild();
      }
    }
  });
}
