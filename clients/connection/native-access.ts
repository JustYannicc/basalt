import { authRequest, pause } from "./device-oauth.ts";

/** Only this read is repeatable. Token exchanges and application operations never enter it. */
export async function nativeAccess(origin: string, accessToken: string, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await authRequest(
        origin,
        "/api/auth/native/access",
        {
          headers: { authorization: `Bearer ${accessToken}` },
        },
        AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
      );
      if (response.status < 500 || attempt === 2) return response;
      await response.body?.cancel();
    } catch (error) {
      signal.throwIfAborted();
      if (attempt === 2) throw error;
    }
    await pause(250 * 4 ** attempt, signal);
  }
}
