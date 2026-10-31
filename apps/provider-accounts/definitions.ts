import { defineProvider, interactive, oauth2, object, secrets, string } from "apps";

const token = (label = "API key") => secrets({
  label,
  fields: object({ token: string({ minLength: 1 }) }),
});
const subscription = (label: string) => interactive({ label, acquisition: "host" });

// These definitions are shared by provider apps, native pools and the trusted host registry.
// Changing a method or its fields changes the provider identity and requires explicit adoption.
export const providers = {
  openai: defineProvider({
    name: "OpenAI", hosts: ["api.openai.com", "chatgpt.com"],
    auth: { codex: subscription("ChatGPT subscription"), apiKey: token("OpenAI API key") },
  }),
  anthropic: defineProvider({
    name: "Anthropic", hosts: ["api.anthropic.com"],
    auth: { claude: subscription("Claude subscription"), apiKey: token("Anthropic API key") },
  }),
  gemini: defineProvider({
    name: "Gemini", hosts: ["generativelanguage.googleapis.com", "cloudcode-pa.googleapis.com"],
    auth: { geminiCli: subscription("Gemini CLI"), apiKey: token("Gemini API key") },
  }),
  vertex: defineProvider({
    name: "Google Vertex AI", hosts: ["*.aiplatform.googleapis.com", "aiplatform.googleapis.com"],
    auth: {
      serviceAccount: secrets({ label: "Service account", fields: object({ serviceAccount: string({ minLength: 1 }) }) }),
      apiKey: token("Vertex AI API key"),
    },
  }),
  antigravity: defineProvider({
    name: "Antigravity", hosts: ["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"],
    auth: { antigravity: subscription("Google subscription") },
  }),
  kimi: defineProvider({
    name: "Kimi", hosts: ["api.kimi.com", "api.kimi.ai", "api.moonshot.ai"],
    auth: { kimi: subscription("Kimi.com subscription"), "kimi-ai": subscription("Kimi.ai subscription"), apiKey: token("Moonshot API key") },
  }),
  xai: defineProvider({
    name: "xAI", hosts: ["api.x.ai", "grok.com"],
    auth: { xai: subscription("Grok subscription"), apiKey: token("xAI API key") },
  }),
  devin: defineProvider({ name: "Devin", hosts: ["api.devin.ai"], auth: { devin: subscription("Devin subscription") } }),
  meta: defineProvider({
    name: "Meta", hosts: ["api.llama.com", "meta.ai"],
    auth: { meta: subscription("Meta subscription"), apiKey: token("Meta API key") },
  }),
  // Match the published tool apps exactly. Placement declarations would change these identities.
  jev: defineProvider({ name: "Jev", hosts: ["api.typesafe.ai"], auth: { apiKey: token("TypeSafe API key") } }),
  cloudflare: defineProvider({
    name: "Cloudflare", hosts: ["mcp.cloudflare.com", "api.cloudflare.com"],
    auth: {
      oauth: oauth2({ discover: "https://mcp.cloudflare.com/mcp" }),
      apiToken: token("User API token"),
      accountToken: secrets({ label: "Account API token", fields: object({ accountId: string({ minLength: 1 }), token: string({ minLength: 1 }) }) }),
    },
  }),
  openrouter: defineProvider({ name: "OpenRouter", hosts: ["openrouter.ai"], auth: { apiKey: token("OpenRouter API key") } }),
  qwen: defineProvider({ name: "Qwen", auth: { subscription: subscription("Qwen subscription") } }),
  iflow: defineProvider({ name: "iFlow", auth: { subscription: subscription("iFlow subscription") } }),
};

export type ProviderLab = keyof typeof providers;

// The legacy Subscription requirement remains separate until an exact-ID adoption is approved.
export const nativePoolAccounts = Object.fromEntries(
  Object.entries(providers).map(([lab, provider]) => [lab, provider.many()]),
);
