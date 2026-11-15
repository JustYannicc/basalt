import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { AcceptanceFailure, isObject } from "./types.ts";
import type { SetupPayload } from "./preview-client.ts";
import type { NativeClient } from "./preview-evidence.ts";

export type NativeSetupPayload = SetupPayload;

export type NativePreviewSessionInput = {
  client: NativeClient;
  model: string;
  payload: NativeSetupPayload;
  codexAuthFile?: string;
  marker: string;
  origin: string;
  modelOrigin?: string;
};

const installerLimit = 2 * 1024 * 1024;
function failure(message: string): never {
  throw new AcceptanceFailure(message);
}

function parseOrigin(raw: string): URL {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    return failure("Native preview requires an explicit stage origin");
  }
  if (
    (value.protocol !== "https:" &&
      !(
        value.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(value.hostname)
      )) ||
    value.username ||
    value.password ||
    value.pathname !== "/" ||
    value.search ||
    value.hash
  ) {
    return failure("Native preview requires an HTTPS stage origin without a path");
  }
  return value;
}

function validateInput(input: NativePreviewSessionInput, origin: URL): void {
  const { payload } = input;
  if (
    payload?.version !== 1 ||
    !payload.brand ||
    !payload.credentials ||
    typeof payload.brand.name !== "string" ||
    !payload.brand.name.trim() ||
    typeof payload.brand.mcpServerName !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(payload.brand.mcpServerName) ||
    typeof payload.brand.setup?.id !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(payload.brand.setup.id) ||
    typeof payload.brand.setup.marker !== "string" ||
    !payload.brand.setup.marker.trim()
  ) {
    failure("Native preview setup payload is invalid");
  }
  if (
    !input.model ||
    input.model.length > 256 ||
    /\s/.test(input.model) ||
    !input.marker ||
    input.marker.length > 256 ||
    input.marker.trim() !== input.marker ||
    /\s/.test(input.marker)
  ) {
    failure("Native preview model or marker is invalid");
  }
  const { credentials } = payload;
  if (
    [credentials.modelKey, credentials.toolsToken].some(
      (value) => typeof value !== "string" || !value || /\s/.test(value),
    )
  ) {
    failure("Native preview setup payload is invalid");
  }
  let modelUrl: URL, toolsUrl: URL;
  try {
    modelUrl = new URL(credentials.modelUrl);
    toolsUrl = new URL(credentials.toolsUrl);
  } catch {
    return failure("Native preview setup payload origin does not match the stage");
  }
  const modelOrigin = input.modelOrigin === undefined ? origin : parseOrigin(input.modelOrigin);
  if (
    input.modelOrigin !== undefined &&
    (modelOrigin.protocol !== "http:" || modelOrigin.hostname !== "127.0.0.1" || !modelOrigin.port)
  ) {
    failure("Native preview model override must be an owned loopback origin");
  }
  if (
    modelUrl.origin !== modelOrigin.origin ||
    modelUrl.pathname !== "/" ||
    modelUrl.search ||
    modelUrl.hash ||
    credentials.modelUrl !== modelOrigin.origin ||
    toolsUrl.origin !== origin.origin ||
    toolsUrl.pathname !== "/mcp" ||
    toolsUrl.search ||
    toolsUrl.hash ||
    toolsUrl.username ||
    toolsUrl.password ||
    credentials.toolsUrl !== `${origin.origin}/mcp`
  ) {
    failure("Native preview setup payload origin does not match the stage");
  }
  if (input.client === "codex" && !input.codexAuthFile) {
    failure("Native Codex preview requires its dedicated auth.json");
  }
}

export function nativePreviewOrigin(input: NativePreviewSessionInput): URL {
  const origin = parseOrigin(input.origin);
  validateInput(input, origin);
  return origin;
}

export async function copyNativeCodexAuth(source: string, target: string): Promise<Buffer> {
  try {
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.size > 1_048_576) {
      failure("Native Codex auth must be a private regular auth.json file");
    }
    const bytes = await readFile(source);
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    const tokens = isObject(value) ? value.tokens : undefined;
    if (
      !isObject(value) ||
      value.auth_mode !== "chatgpt" ||
      !isObject(tokens) ||
      !["id_token", "access_token", "refresh_token"].every(
        (key) => typeof tokens[key] === "string" && tokens[key].length > 0,
      )
    ) {
      failure("Native Codex auth must be a dedicated ChatGPT auth.json");
    }
    await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
    await chmod(target, 0o600);
    return bytes;
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error;
    failure("Native Codex auth must be a readable private auth.json file");
  }
}

export async function downloadNativeInstaller(origin: URL, destination: string): Promise<void> {
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
