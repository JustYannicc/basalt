import type { DeviceCredentials } from "../contracts/device.ts";
import { tokenRequest } from "./device-oauth.ts";

export async function refreshDeviceCredentials(
  current: DeviceCredentials,
  signal: AbortSignal,
  commit: (next: DeviceCredentials) => Promise<void>,
) {
  // Intent survives a lost response or process exit; only native whole-call proof permits reuse.
  await commit({ ...current, refreshPending: true });
  const tokens = await tokenRequest(
    current.origin,
    {
      grant_type: "refresh_token",
      resource: `${current.origin}/native`,
      client_id: current.clientId,
      refresh_token: current.refreshToken,
    },
    signal,
  ).catch(async (error: unknown) => {
    if (
      error instanceof Error &&
      error.message === "fetch failed: java.io.IOException: SIGNALBOX_REFRESH_NOT_SENT"
    )
      await commit({ ...current, refreshPending: "not-sent" });
    throw error;
  });
  await commit({ ...current, ...tokens, refreshPending: false });
}
