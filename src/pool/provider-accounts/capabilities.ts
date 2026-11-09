import type { ProviderLab } from "./definitions.ts";

export interface ProviderCapability {
  readonly lab: ProviderLab;
  readonly method: string;
  readonly backend?: string;
  readonly quota: "home" | "none";
  readonly protocol: "chat" | "typesafe-systemone";
  readonly connection:
    | "home-oauth"
    | "token-mirror"
    | "config-mirror"
    | "credential-mirror"
    | "unavailable";
  readonly reason?: string;
}

const oauth = (
  lab: ProviderLab,
  method: string,
  backend: string,
  quota: ProviderCapability["quota"],
): ProviderCapability => ({
  lab,
  method,
  backend,
  quota,
  protocol: "chat",
  connection: "home-oauth",
});
export const availableProviderCapabilities: readonly ProviderCapability[] = [
  oauth("openai", "codex", "codex", "home"),
  oauth("anthropic", "claude", "claude", "home"),
  oauth("gemini", "geminiCli", "gemini-cli", "none"),
  oauth("antigravity", "antigravity", "antigravity", "home"),
  oauth("kimi", "kimi", "kimi", "home"),
  oauth("kimi", "kimi-ai", "kimi-ai", "none"),
  oauth("xai", "xai", "xai", "home"),
  oauth("devin", "devin", "devin", "none"),
  oauth("meta", "meta", "meta", "home"),
  {
    lab: "jev",
    method: "apiKey",
    backend: "typesafe",
    protocol: "typesafe-systemone",
    quota: "none",
    connection: "token-mirror",
  },
  ...(
    ["openai", "anthropic", "gemini", "vertex", "kimi", "xai", "meta", "openrouter"] as const
  ).map((lab) => ({
    lab,
    method: "apiKey",
    protocol: "chat" as const,
    quota: "none" as const,
    connection: "config-mirror" as const,
  })),
  {
    lab: "vertex",
    method: "serviceAccount",
    protocol: "chat",
    quota: "none",
    backend: "vertex",
    connection: "credential-mirror",
  },
  ...(["apiToken", "accountToken"] as const).map((method) => ({
    lab: "cloudflare" as const,
    method,
    protocol: "chat" as const,
    quota: "none" as const,
    connection: "config-mirror" as const,
  })),
];

export const providerCapabilities: readonly ProviderCapability[] = [
  ...availableProviderCapabilities,
  ...(["qwen", "iflow"] as const).map((lab) => ({
    lab,
    method: "subscription",
    protocol: "chat" as const,
    quota: "none" as const,
    connection: "unavailable" as const,
    reason: "The pinned backend has no supported subscription sign-in for this service.",
  })),
];

/** Only these registered methods have a collector in the pinned Home backend. */
export const quotaProviderIds = availableProviderCapabilities.flatMap((capability) =>
  capability.quota === "home" && capability.backend !== undefined ? [capability.backend] : [],
);
