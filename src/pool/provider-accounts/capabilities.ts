import type { ProviderLab } from "./definitions.ts";

export interface ProviderCapability {
  readonly lab: ProviderLab;
  readonly method: string;
  readonly backend?: string;
  readonly protocol: "chat" | "typesafe-systemone";
  readonly connection: "home-oauth" | "token-mirror" | "unavailable";
  readonly reason?: string;
}

export const providerCapabilities: readonly ProviderCapability[] = [
  { lab: "openai", method: "codex", backend: "codex", protocol: "chat", connection: "home-oauth" },
  { lab: "anthropic", method: "claude", backend: "claude", protocol: "chat", connection: "home-oauth" },
  { lab: "gemini", method: "geminiCli", backend: "gemini-cli", protocol: "chat", connection: "home-oauth" },
  { lab: "antigravity", method: "antigravity", backend: "antigravity", protocol: "chat", connection: "home-oauth" },
  { lab: "kimi", method: "kimi", backend: "kimi", protocol: "chat", connection: "home-oauth" },
  { lab: "kimi", method: "kimi-ai", backend: "kimi-ai", protocol: "chat", connection: "home-oauth" },
  { lab: "xai", method: "xai", backend: "xai", protocol: "chat", connection: "home-oauth" },
  { lab: "devin", method: "devin", backend: "devin", protocol: "chat", connection: "home-oauth" },
  { lab: "meta", method: "meta", backend: "meta", protocol: "chat", connection: "home-oauth" },
  { lab: "jev", method: "apiKey", backend: "typesafe", protocol: "typesafe-systemone", connection: "token-mirror" },
  ...(["openai", "anthropic", "gemini", "vertex", "kimi", "xai", "meta", "openrouter"] as const).map((lab) => ({
    lab, method: "apiKey", protocol: "chat" as const, connection: "unavailable" as const,
    reason: "The native API-key definition is available; its Home configuration adapter is not installed.",
  })),
  { lab: "vertex", method: "serviceAccount", protocol: "chat", connection: "unavailable", reason: "A durable Home service-account import is not connected yet." },
  ...(["apiToken", "accountToken"] as const).map((method) => ({
    lab: "cloudflare" as const, method, protocol: "chat" as const, connection: "unavailable" as const,
    reason: "Choose a Workers AI account, verify inference permission and configure its supported compatible endpoint first.",
  })),
  ...(["qwen", "iflow"] as const).map((lab) => ({
    lab, method: "subscription", protocol: "chat" as const, connection: "unavailable" as const,
    reason: "The pinned backend has no supported subscription sign-in for this service.",
  })),
];
