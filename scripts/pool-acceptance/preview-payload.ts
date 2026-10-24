import { AcceptanceFailure, isObject } from "./types.ts";

export type SetupCredentials = {
  readonly modelUrl: string;
  readonly modelKey: string;
  readonly toolsUrl: string;
  readonly toolsToken: string;
};

export type SetupPayload = {
  readonly version: 1;
  readonly brand: {
    readonly name: string;
    readonly mcpServerName: string;
    readonly setup: {
      readonly id: string;
      readonly marker: string;
      readonly [key: string]: unknown;
    };
    readonly [key: string]: unknown;
  };
  readonly credentials: SetupCredentials;
  readonly instructions: string;
};

export type ComputerEvidence = {
  readonly firstModelRequestAt: string;
  readonly firstToolCallAt: string;
};

export function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new AcceptanceFailure(`${label} was missing`);
  return value;
}

export function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new AcceptanceFailure(`${label} was not an ISO timestamp`);
  }
  try {
    if (new Date(value).toISOString() !== value) throw new Error();
  } catch {
    throw new AcceptanceFailure(`${label} was not an ISO timestamp`);
  }
  return value;
}

export function computerId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new AcceptanceFailure("Computer ID was invalid");
  return value;
}

export function setupPayload(value: unknown, origin: string): SetupPayload {
  if (!isObject(value) || value.version !== 1 || !isObject(value.brand) || !isObject(value.brand.setup) ||
    !isObject(value.credentials) || typeof value.instructions !== "string" ||
    typeof value.brand.name !== "string" || typeof value.brand.mcpServerName !== "string" ||
    typeof value.brand.setup.id !== "string" || typeof value.brand.setup.marker !== "string") {
    throw new AcceptanceFailure("Setup claim did not return the expected payload");
  }

  const credentials = value.credentials;
  const modelUrl = requiredText(credentials.modelUrl, "Setup model URL");
  const toolsUrl = requiredText(credentials.toolsUrl, "Setup tools URL");
  const modelKey = requiredText(credentials.modelKey, "Setup model key");
  const toolsToken = requiredText(credentials.toolsToken, "Setup tools token");
  let model: URL;
  let tools: URL;
  try {
    model = new URL(modelUrl);
    tools = new URL(toolsUrl);
  } catch {
    throw new AcceptanceFailure("Setup credentials contained an invalid service URL");
  }
  if (model.origin !== origin || (model.pathname !== "/" && model.pathname !== "") || model.search || model.hash ||
    model.username || model.password) {
    throw new AcceptanceFailure("Setup model URL did not match the preview origin");
  }
  if (tools.origin !== origin || tools.pathname !== "/mcp" || tools.search || tools.hash ||
    tools.username || tools.password) {
    throw new AcceptanceFailure("Setup tools URL did not match the preview MCP endpoint");
  }

  return {
    version: 1,
    brand: value.brand as SetupPayload["brand"],
    credentials: { modelUrl, modelKey, toolsUrl, toolsToken },
    instructions: value.instructions,
  };
}

export function claimUrlFromPrompt(promptValue: unknown, origin: string): URL {
  if (typeof promptValue !== "string" || !promptValue.trim()) {
    throw new AcceptanceFailure("Setup response omitted its one-time prompt");
  }
  const candidates = [...promptValue.matchAll(/https?:\/\/[^\s<>"']+/g)];
  if (candidates.length !== 1) throw new AcceptanceFailure("Setup prompt did not contain exactly one claim URL");
  const candidate = candidates[0]![0].replace(/[),.;!?]+$/, "");
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new AcceptanceFailure("Setup prompt contained an invalid claim URL");
  }
  const match = /^\/setup\/claim\/([a-f0-9]{64})$/i.exec(url.pathname);
  if (url.origin !== origin || !match || url.search || url.hash || url.username || url.password) {
    throw new AcceptanceFailure("Setup prompt claim URL did not match the preview origin");
  }
  return url;
}
