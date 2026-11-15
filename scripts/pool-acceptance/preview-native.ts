import {
  nativePreviewOrigin,
  copyNativeCodexAuth,
  downloadNativeInstaller,
  type NativePreviewSessionInput,
} from "./preview-native-input.ts";
export type { NativeSetupPayload, NativePreviewSessionInput } from "./preview-native-input.ts";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AcceptanceFailure, isObject } from "./types.ts";
import { createPreviewProcessRunner } from "./preview-process.ts";
import { hasNativePreviewEvidence } from "./preview-evidence.ts";

export type { NativeClient } from "./preview-evidence.ts";

export type NativePreviewSession = {
  run(): Promise<{
    modelReplyMatched: true;
    toolCallObserved: true;
    chatgptAuthPreserved?: true;
    refreshTokenUntouched?: true;
  }>;
  undo(): Promise<void>;
  dispose(): Promise<void>;
};

const installerTimeoutMs = 60_000;
const nativeTimeoutMs = 240_000;

function failure(message: string): never {
  throw new AcceptanceFailure(message);
}

async function executable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return failure(`Native preview requires the installed ${name} CLI`);
}

/** One session owns its staged installer, isolated client home, native turn, and verified undo. */
export async function createNativePreviewSession(
  input: NativePreviewSessionInput,
): Promise<NativePreviewSession> {
  const origin = nativePreviewOrigin(input);
  const cliPath = await executable(input.client);
  let payloadText: string;
  try {
    payloadText = JSON.stringify(input.payload);
    if (Buffer.byteLength(payloadText) > 64_000)
      failure("Native preview setup payload is too large");
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error;
    failure("Native preview setup payload is invalid");
  }

  const root = await mkdtemp(join(tmpdir(), "pool-native-preview-"));
  const home = join(root, "home");
  const claudeHome = join(root, "claude");
  const codexHome = join(root, "codex");
  const work = join(root, "work");
  const temp = join(root, "tmp");
  const xdg = join(root, "xdg");
  const installer = join(root, "client.mjs");
  const payloadFile = join(root, "payload.json");
  const paths = [
    join(claudeHome, "settings.json"),
    join(claudeHome, ".claude.json"),
    join(codexHome, "config.toml"),
  ];
  let installerAttempted = false;
  let runStarted = false;
  let undoSucceeded = false;
  let disposed = false;
  let undoTask: Promise<void> | undefined;
  let codexAuth: Buffer | undefined;
  const verifyAuthPreserved = async () => {
    if (codexAuth === undefined) return;
    try {
      if (!(await readFile(join(codexHome, "auth.json"))).equals(codexAuth)) throw 0;
    } catch {
      failure("Native Codex setup changed the existing ChatGPT auth or refresh token");
    }
  };

  const childEnv = {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    TMPDIR: temp,
    XDG_CONFIG_HOME: xdg,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: codexHome,
    NO_COLOR: "1",
    TERM: "dumb",
  };
  const processRunner = createPreviewProcessRunner({ env: childEnv });

  const verifyConfigRemoved = async (): Promise<void> => {
    for (const path of paths) {
      try {
        await lstat(path);
        failure("Native preview cleanup left installed client config behind");
      } catch (error) {
        if (error instanceof AcceptanceFailure) throw error;
        if (!isObject(error) || error.code !== "ENOENT")
          failure("Native preview cleanup could not be verified");
      }
    }
  };

  const undo = async (): Promise<void> => {
    if (undoSucceeded) return;
    if (undoTask) return undoTask;
    undoTask = (async () => {
      await processRunner.stop();
      if (installerAttempted) {
        const lock = join(home, ".local", "state", input.payload.brand.setup.id, "lock");
        await rm(lock, { recursive: true, force: true }).catch(() => {});
        const result = await processRunner.run(
          process.execPath,
          [installer, "--undo"],
          work,
          installerTimeoutMs,
        );
        if (result.code !== 0 || result.timedOut || result.truncated || result.failedToStart) {
          failure("Native preview cleanup failed in the stage installer");
        }
        await verifyConfigRemoved();
        await verifyAuthPreserved();
      }
      undoSucceeded = true;
    })().finally(() => {
      undoTask = undefined;
    });
    return undoTask;
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    let cleanupFailed = false;
    try {
      await undo();
    } catch {
      cleanupFailed = true;
    }
    try {
      await processRunner.stop();
    } catch {
      cleanupFailed = true;
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      cleanupFailed = true;
    }
    disposed = true;
    if (cleanupFailed)
      failure("Native preview cleanup failed; the isolated home was removed where possible");
  };

  try {
    await chmod(root, 0o700);
    for (const directory of [home, claudeHome, codexHome, work, temp, xdg])
      await mkdir(directory, { recursive: true, mode: 0o700 });
    await Promise.all([
      chmod(home, 0o700),
      chmod(claudeHome, 0o700),
      chmod(codexHome, 0o700),
      chmod(work, 0o700),
      chmod(temp, 0o700),
      chmod(xdg, 0o700),
    ]);
    await writeFile(payloadFile, payloadText, { mode: 0o600, flag: "wx" });
    await chmod(payloadFile, 0o600);
    if (input.client === "codex")
      codexAuth = await copyNativeCodexAuth(input.codexAuthFile!, join(codexHome, "auth.json"));
    await downloadNativeInstaller(origin, installer);
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    if (error instanceof AcceptanceFailure) throw error;
    failure("Native preview session setup failed");
  }

  return {
    async run() {
      if (disposed || runStarted || undoSucceeded)
        failure("Native preview session cannot run in its current state");
      runStarted = true;
      installerAttempted = true;
      const installed = await processRunner.run(
        process.execPath,
        [installer, "--payload-file", payloadFile],
        work,
        installerTimeoutMs,
      );
      if (
        installed.code !== 0 ||
        installed.timedOut ||
        installed.truncated ||
        installed.failedToStart
      ) {
        try {
          await undo();
        } catch {
          failure("Native preview installer failed and cleanup could not be verified");
        }
        failure("Native preview installer failed");
      }

      await verifyAuthPreserved();
      const prompt = `Call the ${input.payload.brand.mcpServerName} MCP search tool with exactly {"query":"pool","limit":1}. After it returns, reply with exactly ${input.marker} and no other text.`;
      const args =
        input.client === "claude"
          ? [
              "--bare",
              "--print",
              "--no-session-persistence",
              "--setting-sources",
              "",
              "--settings",
              paths[0],
              "--strict-mcp-config",
              "--mcp-config",
              paths[1],
              "--tools",
              "",
              "--allowedTools",
              `mcp__${input.payload.brand.mcpServerName}__search`,
              "--model",
              input.model,
              "--output-format",
              "stream-json",
              "--verbose",
              prompt,
            ]
          : [
              "exec",
              "--ephemeral",
              "--skip-git-repo-check",
              "--sandbox",
              "read-only",
              "--disable",
              "apps",
              "--model",
              input.model,
              "--json",
              prompt,
            ];
      const result = await processRunner.run(cliPath, args, work, nativeTimeoutMs);
      if (
        result.code !== 0 ||
        result.timedOut ||
        result.truncated ||
        result.failedToStart ||
        !hasNativePreviewEvidence(
          input.client,
          result.stdout,
          input.payload.brand.mcpServerName,
          input.marker,
        )
      ) {
        failure("Native CLI preview did not observe the expected model reply and MCP search");
      }
      await verifyAuthPreserved();
      return {
        modelReplyMatched: true,
        toolCallObserved: true,
        ...(input.client === "codex"
          ? ({ chatgptAuthPreserved: true, refreshTokenUntouched: true } as const)
          : {}),
      };
    },
    undo,
    dispose,
  };
}
