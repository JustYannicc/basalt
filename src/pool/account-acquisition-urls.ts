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

/** xAI displays a code; its state stays in the server-owned acquisition attempt. */
export function xaiSignInCode(value: string, state: string): string | null {
  const pasted = value.trim();
  if (!pasted || /\s/.test(pasted)) return null;
  try {
    const url = new URL(pasted);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const suppliedState = url.searchParams.get("state");
    if (suppliedState !== null && suppliedState !== state) return null;
    return url.searchParams.get("code")?.trim() || null;
  } catch {
    return pasted.includes("#") ? null : pasted;
  }
}
