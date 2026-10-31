import {
  readDirectCredentials,
  type ConnectionView,
  type CredentialSource,
  type DirectCredentials,
} from "../contracts/connection.ts";

export function directConnection(
  initial: DirectCredentials,
  store: { read(): Promise<string | undefined>; remove(): Promise<void> },
): CredentialSource {
  let credentials: DirectCredentials | undefined = initial;
  let state: ConnectionView["state"] = "connected";
  return {
    view: () => ({
      state,
      mode: "direct",
      capabilities: credentials
        ? [
            ...(credentials.models ? ["models" as const] : []),
            ...(credentials.tools ? ["tools" as const] : []),
          ]
        : [],
    }),
    credentials: async (signal) => {
      signal.throwIfAborted();
      if (state !== "connected" || !credentials)
        throw new Error("The connection is not signed in.");
      return credentials;
    },
    disconnect: async () => {
      state = "disconnected";
    },
    reconnect: async () => {
      const saved = await store.read();
      if (saved === undefined) {
        state = "sign-in-required";
        throw new Error("Sign in before reconnecting.");
      }
      credentials = readDirectCredentials(JSON.parse(saved));
      state = "connected";
    },
    signOut: async () => {
      state = "sign-in-required";
      credentials = undefined;
      await store.remove();
    },
    revoke: async () => {
      throw new Error(
        "Direct keys are revoked on their issuing server. This connection is not a device grant.",
      );
    },
  };
}
