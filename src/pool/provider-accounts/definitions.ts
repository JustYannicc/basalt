import {
  defineProvider,
  interactive,
  oauth2,
  object,
  plain,
  secrets,
  string,
  type AuthMethods,
} from "apps";

import { cloudflareOAuthScopes } from "./cloudflare-scopes.ts";

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
// The address and model names are not secret, so the form shows them and the account row can too.
const endpoint = (label: string) =>
  secrets({
    label,
    fields: object({
      baseUrl: plain(string({ minLength: 1 })),
      models: plain(string({ minLength: 1 })),
      token: string({ minLength: 1 }),
    }),
  });

/** Why a custom endpoint's address or model list is refused, worded for the person entering it. */
export const customEndpointRefusals = {
  address:
    "Enter a public https address without credentials, a query or a fragment. Local and private addresses and IPv6 literals are refused.",
  models: "Enter one to 200 model names, separated by commas.",
} as const;

// Loopback, private, shared, link-local, reserved, documentation and multicast IPv4 ranges.
function reservedIpv4(host: string): boolean {
  const [a, b, c] = host.split(".").map(Number) as [number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/**
 * The gateway address calls go to, without a trailing `/v1` since each family adds its own path,
 * or undefined when refused. A public name that resolves to a private address is not caught here;
 * the runtime's own egress decides that. The connect form's check and the pool mirror both use it.
 */
export function customEndpointAddress(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    return undefined;
  const host = url.hostname.toLowerCase().replace(/\.+$/u, "");
  // IPv6 literals are refused whole: the URL parser rewrites mapped IPv4 forms, so a partial
  // classification would be easy to get wrong.
  if (
    host.startsWith("[") ||
    host === "localhost" ||
    /\.(?:localhost|local|localdomain|lan|internal|home\.arpa|svc|cluster\.local)$/u.test(host) ||
    !host.includes(".")
  )
    return undefined;
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(host) && reservedIpv4(host)) return undefined;
  const path = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "").replace(/\/+$/u, "");
  return `${url.origin}${path}`;
}

/** The distinct model names a custom endpoint serves, or undefined when the list is refused. */
export function customEndpointModels(value: string): readonly string[] | undefined {
  // Commas separate names; a name with a space inside is refused rather than split in two.
  const names = [
    ...new Set(
      value
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== ""),
    ),
  ];
  return names.length >= 1 &&
    names.length <= 200 &&
    names.every((name) => /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/u.test(name))
    ? names
    : undefined;
}

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
      oauth: oauth2({
        discover: "https://mcp.cloudflare.com/mcp",
        scopes: [...cloudflareOAuthScopes],
      }),
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
  custom: modelProvider({
    family: {
      id: "custom",
      name: "Custom endpoint",
      methods: { anthropic: apiKeyMethod, openai: apiKeyMethod },
    },
    auth: {
      anthropic: endpoint("Anthropic-compatible endpoint"),
      openai: endpoint("OpenAI-compatible endpoint"),
    },
    // Applies the entry rules only and sends nothing: the form shows the thrown message, and a
    // gateway answer would prove nothing about the names the pool will ask it for.
    health: async ({ account }) => {
      if (customEndpointAddress(account.fields.baseUrl) === undefined)
        throw new Error(customEndpointRefusals.address);
      if (customEndpointModels(account.fields.models) === undefined)
        throw new Error(customEndpointRefusals.models);
    },
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
