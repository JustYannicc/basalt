// Basalt writes this from src/pool/providers.json when it bundles the app.
export const providers: readonly { readonly id: string; readonly name: string }[] = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "ChatGPT" },
];
