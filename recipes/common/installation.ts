import { defineProvider, object, string, secrets, oauth2 } from "apps";

export const origin = "https://app.signalbox.run";
// Match the installation's existing management provider so its native account can be linked.
export const provider = defineProvider({
  name: "Signalbox",
  auth: {
    apiKey: secrets({
      label: "Signalbox API key",
      fields: object({ token: string(), organization: string() }),
    }),
    oauth: oauth2({ discover: `${origin}/api` }),
  },
});
export const requirements = { user: { accounts: { service: provider } } };
