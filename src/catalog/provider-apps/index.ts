import type { Addition } from "../feed.ts";
import openai from "./openai.json" with { type: "json" };
import anthropic from "./anthropic.json" with { type: "json" };
import { anthropicIcons, openaiIcons } from "./logos.ts";

export const providerApps: readonly Addition[] = [
  {
    entry: {
      id: "provider-openai",
      package: openai.package,
      name: "OpenAI",
      description: "Connect ChatGPT subscriptions and reuse your OpenAI accounts in pools.",
      category: "AI providers",
      auth: [{ method: "codex", kind: "interactive", label: "ChatGPT subscription" }],
      icons: [...openaiIcons],
      source: "apps/provider-openai.json",
    },
    source: openai,
  },
  {
    entry: {
      id: "provider-anthropic",
      package: anthropic.package,
      name: "Anthropic",
      description: "Connect Claude subscriptions and reuse your Anthropic accounts in pools.",
      category: "AI providers",
      auth: [{ method: "claude", kind: "interactive", label: "Claude subscription" }],
      icons: [...anthropicIcons],
      source: "apps/provider-anthropic.json",
    },
    source: anthropic,
  },
];
