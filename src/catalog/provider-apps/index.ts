import type { Addition } from "../feed.ts";
import { providerCapabilities } from "../../pool/provider-accounts/capabilities.ts";
import openai from "./openai.json" with { type: "json" };
import anthropic from "./anthropic.json" with { type: "json" };
import gemini from "./gemini.json" with { type: "json" };
import vertex from "./vertex.json" with { type: "json" };
import antigravity from "./antigravity.json" with { type: "json" };
import kimi from "./kimi.json" with { type: "json" };
import xai from "./xai.json" with { type: "json" };
import devin from "./devin.json" with { type: "json" };
import meta from "./meta.json" with { type: "json" };
import jev from "./jev.json" with { type: "json" };
import cloudflare from "./cloudflare.json" with { type: "json" };
import openrouter from "./openrouter.json" with { type: "json" };
import icons from "./provider-icons.json" with { type: "json" };
import { anthropicIcons, openaiIcons } from "./logos.ts";

const sources = {
  openai,
  anthropic,
  gemini,
  vertex,
  antigravity,
  kimi,
  xai,
  devin,
  meta,
  jev,
  cloudflare,
  openrouter,
};
const names = {
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
};
const methodLabels: Readonly<Record<string, string>> = {
  codex: "ChatGPT subscription",
  claude: "Claude subscription",
  geminiCli: "Gemini CLI",
  antigravity: "Google subscription",
  kimi: "Kimi.com subscription",
  "kimi-ai": "Kimi.ai subscription",
  xai: "Grok subscription",
  devin: "Devin subscription",
  meta: "Meta subscription",
  apiKey: "API key",
  serviceAccount: "Service account",
  apiToken: "User API token",
  accountToken: "Account API token",
};

export const providerApps: readonly Addition[] = Object.entries(sources).map(([id, source]) => {
  const lab = id as keyof typeof sources;
  const name = names[lab];
  return {
    entry: {
      id: `provider-${lab}`,
      package: source.package,
      name,
      description:
        lab === "jev"
          ? "Use your Jev account for typed decisions through pools."
          : `Connect your ${name} accounts and reuse them in pools.`,
      category: "AI providers",
      auth: providerCapabilities
        .filter((capability) => capability.lab === lab && capability.connection !== "unavailable")
        .map((capability) => ({
          method: capability.method,
          kind: capability.connection === "home-oauth" ? "interactive" : "secrets",
          label: methodLabels[capability.method] ?? capability.method,
        })),
      icons:
        lab === "openai"
          ? [...openaiIcons]
          : lab === "anthropic"
            ? [...anthropicIcons]
            : icons[lab],
      source: `apps/provider-${lab}.json`,
    },
    source,
  };
});
