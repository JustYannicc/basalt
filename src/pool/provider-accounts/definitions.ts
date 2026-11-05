import {
  defineProvider,
  interactive,
  oauth2,
  object,
  secrets,
  string,
  type AuthMethods,
} from "apps";

const modelProvider = <const Auth extends AuthMethods>(
  options: Omit<Parameters<typeof defineProvider<Auth>>[0], "name" | "family"> & {
    readonly family: NonNullable<Parameters<typeof defineProvider<Auth>>[0]["family"]>;
  },
) => defineProvider({ ...options, name: options.family.name });

const token = (label = "API key") =>
  secrets({
    label,
    fields: object({ token: string({ minLength: 1 }) }),
  });
const subscription = (label: string) => interactive({ label, acquisition: "host" });

const apiKeyMethod = { mechanism: "api-key" } as const;
const subscriptionMethod = { mechanism: "interactive", offering: "subscription" } as const;

// These definitions are shared by provider apps, native pools and the trusted host registry.
// Changing a method or its fields changes the provider identity and requires explicit adoption.
export const acquisitionProviders = {
  openai: modelProvider({
    family: {
      id: "openai",
      name: "OpenAI",
      methods: {
        codex: subscriptionMethod,
        apiKey: apiKeyMethod,
      },
    },
    hosts: ["api.openai.com", "chatgpt.com"],
    auth: { codex: subscription("ChatGPT subscription"), apiKey: token("OpenAI API key") },
  }),
  anthropic: modelProvider({
    family: {
      id: "anthropic",
      name: "Anthropic",
      methods: {
        claude: subscriptionMethod,
        apiKey: apiKeyMethod,
      },
    },
    hosts: ["api.anthropic.com"],
    auth: { claude: subscription("Claude subscription"), apiKey: token("Anthropic API key") },
  }),
  gemini: modelProvider({
    family: {
      id: "gemini",
      name: "Gemini",
      methods: { geminiCli: { mechanism: "interactive" }, apiKey: apiKeyMethod },
    },
    hosts: ["generativelanguage.googleapis.com", "cloudcode-pa.googleapis.com"],
    auth: { geminiCli: subscription("Gemini CLI"), apiKey: token("Gemini API key") },
  }),
  vertex: modelProvider({
    family: {
      id: "vertex",
      name: "Google Vertex AI",
      methods: { serviceAccount: { mechanism: "other" }, apiKey: apiKeyMethod },
    },
    hosts: ["*.aiplatform.googleapis.com", "aiplatform.googleapis.com"],
    auth: {
      serviceAccount: secrets({
        label: "Service account",
        fields: object({ serviceAccount: string({ minLength: 1 }) }),
      }),
      apiKey: token("Vertex AI API key"),
    },
  }),
  antigravity: modelProvider({
    family: {
      id: "antigravity",
      name: "Antigravity",
      methods: { antigravity: subscriptionMethod },
    },
    hosts: ["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"],
    auth: { antigravity: subscription("Google subscription") },
  }),
  kimi: modelProvider({
    family: {
      id: "kimi",
      name: "Kimi",
      methods: {
        kimi: subscriptionMethod,
        "kimi-ai": subscriptionMethod,
        apiKey: apiKeyMethod,
      },
    },
    hosts: ["api.kimi.com", "api.kimi.ai", "api.moonshot.ai"],
    auth: {
      kimi: subscription("Kimi.com subscription"),
      "kimi-ai": subscription("Kimi.ai subscription"),
      apiKey: token("Moonshot API key"),
    },
  }),
  xai: modelProvider({
    family: {
      id: "xai",
      name: "xAI",
      methods: {
        xai: subscriptionMethod,
        apiKey: apiKeyMethod,
      },
    },
    hosts: ["api.x.ai", "grok.com"],
    auth: { xai: subscription("Grok subscription"), apiKey: token("xAI API key") },
  }),
  devin: modelProvider({
    family: {
      id: "devin",
      name: "Devin",
      methods: { devin: subscriptionMethod },
    },
    hosts: ["api.devin.ai"],
    auth: { devin: subscription("Devin subscription") },
  }),
  meta: modelProvider({
    family: {
      id: "meta",
      name: "Meta",
      methods: {
        meta: subscriptionMethod,
        apiKey: apiKeyMethod,
      },
    },
    hosts: ["api.llama.com", "meta.ai"],
    auth: { meta: subscription("Meta subscription"), apiKey: token("Meta API key") },
  }),
  // Match the published tool apps exactly. Placement declarations would change these identities.
  jev: modelProvider({
    family: { id: "jev", name: "Jev", methods: { apiKey: apiKeyMethod } },
    hosts: ["api.typesafe.ai"],
    auth: { apiKey: token("TypeSafe API key") },
  }),
  cloudflare: modelProvider({
    family: {
      id: "cloudflare",
      name: "Cloudflare",
      methods: {
        oauth: { mechanism: "oauth" },
        apiToken: apiKeyMethod,
        accountToken: apiKeyMethod,
      },
    },
    hosts: ["mcp.cloudflare.com", "api.cloudflare.com"],
    auth: {
      oauth: oauth2({ discover: "https://mcp.cloudflare.com/mcp" }),
      apiToken: token("User API token"),
      accountToken: secrets({
        label: "Account API token",
        fields: object({ accountId: string({ minLength: 1 }), token: string({ minLength: 1 }) }),
      }),
    },
  }),
  openrouter: modelProvider({
    family: { id: "openrouter", name: "OpenRouter", methods: { apiKey: apiKeyMethod } },
    hosts: ["openrouter.ai"],
    auth: { apiKey: token("OpenRouter API key") },
  }),
};

export const providers = {
  ...acquisitionProviders,
  qwen: modelProvider({
    family: {
      id: "qwen",
      name: "Qwen",
      methods: { subscription: subscriptionMethod },
    },
    auth: { subscription: subscription("Qwen subscription") },
  }),
  iflow: modelProvider({
    family: {
      id: "iflow",
      name: "iFlow",
      methods: { subscription: subscriptionMethod },
    },
    auth: { subscription: subscription("iFlow subscription") },
  }),
};

export type ProviderLab = keyof typeof providers;

// The legacy Subscription requirement remains separate until an exact-ID adoption is approved.
export const nativePoolAccounts = Object.fromEntries(
  Object.entries(providers).map(([lab, provider]) => [
    lab,
    provider.many().requiring("model-inference").contributed(),
  ]),
);
