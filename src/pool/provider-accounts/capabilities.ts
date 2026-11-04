import type { ProviderLab } from "./definitions.ts";

export interface ProviderCapability {
  readonly lab: ProviderLab;
  readonly method: string;
  readonly backend?: string;
  readonly protocol: "chat" | "typesafe-systemone";
  readonly connection:
    | "home-oauth"
    | "token-mirror"
    | "config-mirror"
    | "credential-mirror"
    | "unavailable";
  readonly reason?: string;
}

const oauth = (lab: ProviderLab, method: string, backend = method): ProviderCapability => ({
  lab,
  method,
  backend,
  protocol: "chat",
  connection: "home-oauth",
});
export const availableProviderCapabilities: readonly ProviderCapability[] = [
  oauth("openai", "codex"),
  oauth("anthropic", "claude"),
  oauth("gemini", "geminiCli", "gemini-cli"),
  oauth("antigravity", "antigravity"),
  oauth("kimi", "kimi"),
  oauth("kimi", "kimi-ai"),
  oauth("xai", "xai"),
  oauth("devin", "devin"),
  oauth("meta", "meta"),
  {
    lab: "jev",
    method: "apiKey",
    backend: "typesafe",
    protocol: "typesafe-systemone",
    connection: "token-mirror",
  },
  ...(
    ["openai", "anthropic", "gemini", "vertex", "kimi", "xai", "meta", "openrouter"] as const
  ).map((lab) => ({
    lab,
    method: "apiKey",
    protocol: "chat" as const,
    connection: "config-mirror" as const,
  })),
  {
    lab: "vertex",
    method: "serviceAccount",
    protocol: "chat",
    backend: "vertex",
    connection: "credential-mirror",
  },
  ...(["apiToken", "accountToken"] as const).map((method) => ({
    lab: "cloudflare" as const,
    method,
    protocol: "chat" as const,
    connection: "config-mirror" as const,
  })),
];

export const providerCapabilities: readonly ProviderCapability[] = [
  ...availableProviderCapabilities,
  ...(["qwen", "iflow"] as const).map((lab) => ({
    lab,
    method: "subscription",
    protocol: "chat" as const,
    connection: "unavailable" as const,
    reason: "The pinned backend has no supported subscription sign-in for this service.",
  })),
];
