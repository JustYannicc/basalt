import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AcceptanceFailure, isObject } from "./types.ts";
import type { SetupPayload } from "./preview-client.ts";
import { createPreviewProcessRunner } from "./preview-process.ts";
import { hasNativePreviewEvidence, type NativeClient } from "./preview-evidence.ts";

export type { NativeClient } from "./preview-evidence.ts";

export type NativeSetupPayload = SetupPayload;

export type NativePreviewSessionInput = {
  client: NativeClient;
  model: string;
  payload: NativeSetupPayload;
  codexAuthFile?: string;
  marker: string;
  origin: string;
};

export type NativePreviewSession = {
  run(): Promise<{ modelReplyMatched: true; toolCallObserved: true }>;
  undo(): Promise<void>;
  dispose(): Promise<void>;
};

const installerTimeoutMs = 60_000;
const nativeTimeoutMs = 240_000;
const installerLimit = 2 * 1024 * 1024;

function failure(message: string): never {
  throw new AcceptanceFailure(message);
}

function parseOrigin(raw: string): URL {
  let value: URL;
  try { value = new URL(raw); } catch { return failure("Native preview requires an explicit stage origin"); }
  if ((value.protocol !== "https:" && !(value.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(value.hostname)))
    || value.username || value.password || value.pathname !== "/" || value.search || value.hash) {
    return failure("Native preview requires an HTTPS stage origin without a path");
  }
  return value;
}

function validateInput(input: NativePreviewSessionInput, origin: URL): void {
  const { payload } = input;
  if (payload?.version !== 1 || !payload.brand || !payload.credentials
    || typeof payload.brand.name !== "string" || !payload.brand.name.trim()
    || typeof payload.brand.mcpServerName !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(payload.brand.mcpServerName)
    || typeof payload.brand.setup?.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(payload.brand.setup.id)
    || typeof payload.brand.setup.marker !== "string" || !payload.brand.setup.marker.trim()) {
    failure("Native preview setup payload is invalid");
  }
  if (!input.model || input.model.length > 256 || /\s/.test(input.model)
    || !input.marker || input.marker.length > 256 || input.marker.trim() !== input.marker || /\s/.test(input.marker)) {
    failure("Native preview model or marker is invalid");
  }
  const { credentials } = payload;
  if ([credentials.modelKey, credentials.toolsToken].some(value => typeof value !== "string" || !value || /\s/.test(value))) {
    failure("Native preview setup payload is invalid");
  }
  let modelUrl: URL, toolsUrl: URL;
  try {
    modelUrl = new URL(credentials.modelUrl);
    toolsUrl = new URL(credentials.toolsUrl);
  } catch { return failure("Native preview setup payload origin does not match the stage"); }
  if (modelUrl.origin !== origin.origin || modelUrl.pathname !== "/" || modelUrl.search || modelUrl.hash
    || credentials.modelUrl !== origin.origin
    || toolsUrl.origin !== origin.origin || toolsUrl.pathname !== "/mcp" || toolsUrl.search || toolsUrl.hash
    || toolsUrl.username || toolsUrl.password || credentials.toolsUrl !== `${origin.origin}/mcp`) {
    failure("Native preview setup payload origin does not match the stage");
  }
  if (input.client === "codex" && !input.codexAuthFile) {
    failure("Native Codex preview requires its dedicated auth.json");
  }
}

async function executable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, name);
    try { await access(candidate, fsConstants.X_OK); return candidate; } catch { /* Try the next PATH entry. */ }
  }
  return failure(`Native preview requires the installed ${name} CLI`);
}

async function privateAuthCopy(source: string, target: string): Promise<void> {
  try {
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.size > 1_048_576) {
      failure("Native Codex auth must be a private regular auth.json file");
    }
    const bytes = await readFile(source);
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    const tokens = isObject(value) ? value.tokens : undefined;
    if (!isObject(value) || value.auth_mode !== "chatgpt" || !isObject(tokens)
      || !["id_token", "access_token", "refresh_token"].every(key => typeof tokens[key] === "string" && tokens[key].length > 0)) {
      failure("Native Codex auth must be a dedicated ChatGPT auth.json");
    }
    await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
    await chmod(target, 0o600);
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error;
    failure("Native Codex auth must be a readable private auth.json file");
  }
}

async function downloadInstaller(origin: URL, destination: string): Promise<void> {
  try {
    const stageRouter = { fetch: globalThis.fetch };
    const response = await stageRouter.fetch(new URL("/setup/client.mjs", origin), {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { accept: "text/javascript, application/javascript" },
    });
    if (!response.ok || !response.body) failure("The stage installer could not be downloaded");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > installerLimit) {
        await reader.cancel();
        failure("The stage installer is invalid");
      }
      chunks.push(part.value);
    }
    if (size === 0) failure("The stage installer is invalid");
    await writeFile(destination, Buffer.concat(chunks, size), { mode: 0o600, flag: "wx" });
    await chmod(destination, 0o600);
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error;
    failure("The stage installer could not be downloaded");
  }
}

/** One session owns its staged installer, isolated client home, native turn, and verified undo. */
export async function createNativePreviewSession(input: NativePreviewSessionInput): Promise<NativePreviewSession> {
  const origin = parseOrigin(input.origin);
  validateInput(input, origin);
  const cliPath = await executable(input.client);
  let payloadText: string;
  try {
    payloadText = JSON.stringify(input.payload);
    if (Buffer.byteLength(payloadText) > 64_000) failure("Native preview setup payload is too large");
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
      try { await lstat(path); failure("Native preview cleanup left installed client config behind"); }
      catch (error) {
        if (error instanceof AcceptanceFailure) throw error;
        if (!isObject(error) || error.code !== "ENOENT") failure("Native preview cleanup could not be verified");
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
        const result = await processRunner.run(process.execPath, [installer, "--undo"], work, installerTimeoutMs);
        if (result.code !== 0 || result.timedOut || result.truncated || result.failedToStart) {
          failure("Native preview cleanup failed in the stage installer");
        }
        await verifyConfigRemoved();
      }
      undoSucceeded = true;
    })().finally(() => { undoTask = undefined; });
    return undoTask;
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    let cleanupFailed = false;
    try { await undo(); } catch { cleanupFailed = true; }
    try { await processRunner.stop(); } catch { cleanupFailed = true; }
    try { await rm(root, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    disposed = true;
    if (cleanupFailed) failure("Native preview cleanup failed; the isolated home was removed where possible");
  };

  try {
    await chmod(root, 0o700);
    for (const directory of [home, claudeHome, codexHome, work, temp, xdg]) await mkdir(directory, { recursive: true, mode: 0o700 });
    await Promise.all([chmod(home, 0o700), chmod(claudeHome, 0o700), chmod(codexHome, 0o700), chmod(work, 0o700), chmod(temp, 0o700), chmod(xdg, 0o700)]);
    await writeFile(payloadFile, payloadText, { mode: 0o600, flag: "wx" });
    await chmod(payloadFile, 0o600);
    if (input.client === "codex") await privateAuthCopy(input.codexAuthFile!, join(codexHome, "auth.json"));
    await downloadInstaller(origin, installer);
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    if (error instanceof AcceptanceFailure) throw error;
    failure("Native preview session setup failed");
  }

  return {
    async run() {
      if (disposed || runStarted || undoSucceeded) failure("Native preview session cannot run in its current state");
      runStarted = true;
      installerAttempted = true;
      const installed = await processRunner.run(process.execPath, [installer, "--payload-file", payloadFile], work, installerTimeoutMs);
      if (installed.code !== 0 || installed.timedOut || installed.truncated || installed.failedToStart) {
        try { await undo(); } catch { failure("Native preview installer failed and cleanup could not be verified"); }
        failure("Native preview installer failed");
      }

      const prompt = `Call the ${input.payload.brand.mcpServerName} MCP search tool with exactly {"query":"pool","limit":1}. After it returns, reply with exactly ${input.marker} and no other text.`;
      const args = input.client === "claude"
        ? ["--bare", "--print", "--no-session-persistence", "--setting-sources", "", "--settings", paths[0],
          "--strict-mcp-config", "--mcp-config", paths[1], "--tools", "", "--allowedTools",
          `mcp__${input.payload.brand.mcpServerName}__search`, "--model", input.model, "--output-format", "stream-json", "--verbose", prompt]
        : ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--disable", "apps",
          "--model", input.model, "--json", prompt];
      const result = await processRunner.run(cliPath, args, work, nativeTimeoutMs);
      if (result.code !== 0 || result.timedOut || result.truncated || result.failedToStart
        || !hasNativePreviewEvidence(input.client, result.stdout, input.payload.brand.mcpServerName, input.marker)) {
        failure("Native CLI preview did not observe the expected model reply and MCP search");
      }
      return { modelReplyMatched: true, toolCallObserved: true };
    },
    undo,
    dispose,
  };
}
