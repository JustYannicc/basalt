import { authRequest, pause } from "./device-oauth.ts";

/** Only this read is repeatable. Token exchanges and application operations never enter it. */
export async function nativeAccess(origin: string, accessToken: string, signal: AbortSignal) {
  let attempt = 0;
  for (;;) {
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
      if (response.status === 429) {
        const raw = response.headers.get("retry-after") ?? response.headers.get("x-retry-after");
        const seconds = raw === null ? NaN : Number(raw);
        const delay =
          Number.isFinite(seconds) && seconds >= 0
            ? seconds * 1000
            : raw !== null && Number.isFinite(Date.parse(raw))
              ? Math.max(0, Date.parse(raw) - Date.now())
              : 1000;
        await response.body?.cancel();
        const deadline = Date.now() + delay;
        do {
          await pause(Math.min(Math.max(1, deadline - Date.now()), 2_147_483_647), signal);
        } while (Date.now() < deadline);
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
