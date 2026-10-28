import type { Account, SignInStarted, SignInStatus } from "./contract.ts";

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

/** The identity a connected subscription reports, the way a connected Gmail shows its address. */
export function identityOf(
  account: Pick<Account, "label" | "provider">,
  sites: readonly { readonly id: string; readonly site?: string }[],
) {
  const label = account.label.trim().slice(0, 255);
  const site = sites.find((provider) => provider.id === account.provider)?.site;
  return {
    ...(label ? { displayName: label } : {}),
    ...(/^[^\s@]+@[^\s@]+$/.test(label) ? { email: label } : {}),
    // The same logo service the dashboard uses for provider icons.
    ...(site ? { avatarUrl: `https://integrations.sh/logo/${site}?sz=64` } : {}),
  };
}

export type AccountIdentity = ReturnType<typeof identityOf>;

/** Identity is optional, so its lookup gets a short slice of the connect step and never fails it. */
export const identityLookupMs = 3_000;

/**
 * Add the account's identity to a connected sign-in. Any failure of the lookup, including a
 * malformed or late answer, keeps the connected result as it was.
 */
export async function withIdentity<S extends { readonly state: string; readonly ref?: string }>(
  state: S,
  lookup: () => Promise<{ readonly ok: boolean; readonly value?: { readonly accounts?: readonly Account[] } }>,
  sites: readonly { readonly id: string; readonly site?: string }[],
  timeoutMs = identityLookupMs,
): Promise<S | (S & { accountInfo: AccountIdentity })> {
  if (state.state !== "connected") return state;
  const late = new Promise<S>((resolve) =>
    AbortSignal.timeout(timeoutMs).addEventListener("abort", () => resolve(state), { once: true }),
  );
  const found = Promise.resolve()
    .then(lookup)
    .then((view) => {
      const account = view.ok ? view.value?.accounts?.find((candidate) => candidate.id === state.ref) : undefined;
      return account === undefined ? state : { ...state, accountInfo: identityOf(account, sites) };
    })
    .catch(() => state);
  return await Promise.race([found, late]);
}
