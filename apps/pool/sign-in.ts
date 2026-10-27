import type { SignInStarted, SignInStatus } from "./contract.ts";

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether a pasted address is the local page a provider's sign-in ended on. */
export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && loopback.has(url.hostname);
  } catch {
    return false;
  }
}

/** The local address a sign-in will end on, read from the sign-in link's own redirect. */
export function callbackOrigin(signInUrl: string): string | null {
  try {
    const redirect = new URL(signInUrl).searchParams.get("redirect_uri");
    if (!redirect || !isLoopbackUrl(redirect)) return null;
    return new URL(redirect).origin;
  } catch {
    return null;
  }
}

/** The Connect dialog's method for pasting a login file; backend provider ids are lowercase. */
export const loginFileMethod = "loginFile";

/** What the Connect dialog shows for each sign-in the backend starts. */
export const prompt = {
  signIn(started: SignInStarted) {
    const origin = callbackOrigin(started.url);
    return {
      session: started.session,
      url: started.url,
      ...(started.userCode ? { code: started.userCode } : {}),
      ...(started.flow === "callback"
        ? {
            paste: {
              label: `The tab ends on a page that won't load, at a local address${origin ? ` starting with ${origin}` : ""}. That's expected. Copy the whole address and paste it here.`,
              ...(origin ? { placeholder: `${origin}/…` } : {}),
            },
          }
        : {}),
      expiresAt: Date.parse(started.expiresAt),
    };
  },
  loginFile: {
    session: loginFileMethod,
    message: "Paste a login file the pool backend exported. It connects that subscription without signing in again.",
    paste: { label: "Login file contents", placeholder: "{ … }" },
  },
};

/** The dialog's view of a sign-in, with the pool account it added as the account's reference. */
export function signedIn(status: SignInStatus) {
  if (status.status === "waiting") return { state: "waiting" as const };
  if (status.status === "failed") return { state: "failed" as const, message: status.message };
  if (status.accountId === null)
    return {
      state: "failed" as const,
      message: "The subscription connected, but the pool couldn't tell which account it was. It shows on the pool's page; remove it there and connect it again.",
    };
  return { state: "connected" as const, ref: status.accountId };
}
