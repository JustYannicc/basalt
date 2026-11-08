import { acquisitionStep, invalidSignInCode } from "./account-acquisition-failure.ts";
import { xaiSignInCode } from "./account-acquisition-urls.ts";
import type { HomeClient } from "./control.ts";
import { BackendFailure, ControlFailure, post, text, unavailable } from "./json.ts";

const expired = "xAI sign-in expired. Start again to get a new code.";
const xaiMessages = new Set([
  expired,
  "xAI sign-in was declined. Start again to try another code.",
  "xAI sign-in could not finish. Start again.",
]);

/** Home receives the server-owned state separately when xAI displays an authorization code. */
export const submitAccountCallback = (
  home: HomeClient,
  input: { provider: string; state: string; value: string; signal: AbortSignal },
) =>
  acquisitionStep("oauth_callback", async () => {
    const code = input.provider === "xai" ? xaiSignInCode(input.value, input.state) : undefined;
    if (code === null) throw invalidSignInCode();
    if (code === undefined) {
      const callback = new URL(input.value);
      if (callback.searchParams.get("state") !== input.state) return unavailable();
    }
    try {
      await home.data("/oauth/callback", {
        ...post(
          code === undefined
            ? { provider: input.provider, redirect_url: input.value }
            : { provider: input.provider, state: input.state, code },
        ),
        signal: input.signal,
      });
    } catch (error) {
      const status =
        error instanceof BackendFailure
          ? error.backendStatus
          : error instanceof ControlFailure && error.status === 404
            ? 404
            : undefined;
      if (input.provider !== "xai" || status === undefined) throw error;
      if (status === 400) throw invalidSignInCode();
      if (status === 404) return { state: "failed" as const, message: expired };
      // A completed or failed callback is reconciled through status instead of submitted again.
      if (status !== 409) throw error;
    }
  });

/** Only Home's closed xAI recovery messages cross into the account dialog. */
export function signInFailure(provider: string, status: Record<string, unknown>): string {
  if (provider !== "xai") return "The provider sign-in failed or expired.";
  const message = text(status.error);
  return message && xaiMessages.has(message)
    ? message
    : "xAI could not accept the code or the sign-in expired. Start again to get a new code.";
}
