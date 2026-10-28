// Basalt writes this from src/pool/providers.json when it bundles the app.
export const providers: readonly { readonly id: string; readonly name: string; readonly site?: string }[] = [
  { id: "claude", name: "Claude", site: "claude.ai" },
  { id: "codex", name: "ChatGPT", site: "chatgpt.com" },
];
