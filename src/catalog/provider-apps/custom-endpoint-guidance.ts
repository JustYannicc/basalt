const fields = {
  baseUrl: {
    label: "Base URL",
    expectedFormat:
      "The gateway's https address, such as https://gateway.example.com. A trailing /v1 is dropped. Local and private addresses and IPv6 literals are refused.",
  },
  models: {
    label: "Model names",
    expectedFormat:
      "The exact model names this gateway serves, separated by commas. The pool offers only these names through this account.",
  },
  token: { label: "API key", expectedFormat: "Paste the key only, without Bearer." },
};

/** The form says exactly what the pool checks and sends, since no vendor reading backs this account. */
export const customEndpointGuidance = (["anthropic", "openai"] as const).map((method) => ({
  requirement: "custom",
  method,
  credentials: {
    link:
      method === "anthropic"
        ? {
            label: "Open the Messages API reference",
            url: "https://docs.anthropic.com/en/api/messages",
          }
        : {
            label: "Open the Chat Completions API reference",
            url: "https://platform.openai.com/docs/api-reference/chat",
          },
    steps: [
      method === "anthropic"
        ? "Use a gateway that answers the Anthropic Messages API at /v1/messages."
        : "Use a gateway that answers the OpenAI Chat Completions API at /v1/chat/completions.",
      "Enter its address, the model names it serves and its API key.",
    ],
    note: "Checking these fields sends nothing to the gateway. The pool reads no usage or limits for this account. A call can be priced at a vendor's list price when its model name matches that vendor's model; other names are unpriced.",
    fields,
  },
}));
