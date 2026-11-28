import icons from "./provider-icons.json" with { type: "json" };
import { anthropicIcons, customEndpointIcons, openaiIcons } from "./logos.ts";

export const providerAppNames = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  vertex: "Google Vertex AI",
  antigravity: "Antigravity",
  kimi: "Kimi",
  xai: "xAI",
  devin: "Devin",
  meta: "Meta",
  jev: "Jev",
  cloudflare: "Cloudflare Workers AI",
  openrouter: "OpenRouter",
  custom: "Custom endpoint",
};
export type ProviderAppLab = keyof typeof providerAppNames;

export const providerAppIcons = (lab: ProviderAppLab) =>
  lab === "openai"
    ? openaiIcons
    : lab === "anthropic"
      ? anthropicIcons
      : lab === "custom"
        ? customEndpointIcons
        : icons[lab];
