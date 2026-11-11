import { waitForRetryAfter } from "../contracts/retry-after.ts";
import { authRequest, pause } from "./device-oauth.ts";

/** Only this read is repeatable. Token exchanges and application operations never enter it. */
export async function nativeAccess(
  origin: string,
  accessToken: () => Promise<string>,
  signal: AbortSignal,
) {
  let attempt = 0;
  for (;;) {
    signal.throwIfAborted();
    const bearer = await accessToken();
    try {
      const response = await authRequest(
        origin,
        "/api/auth/native/access",
        {
          headers: { authorization: `Bearer ${bearer}` },
        },
        AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
      );
      if (response.status === 429) {
        await response.body?.cancel();
        await waitForRetryAfter(response.headers, signal);
        continue;
      }
      if (response.status < 500 || attempt === 2) return response;
      await response.body?.cancel();
    } catch (error) {
      signal.throwIfAborted();
      if (attempt === 2) throw error;
    }
    await pause(250 * 4 ** attempt++, signal);
  }
}
