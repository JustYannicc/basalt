import { mapBounded } from "./bounded.ts";
import { PoolHome, usageSession, type HomeClient } from "./control.ts";
import { fail, object, rows, text, unavailable } from "./json.ts";
import { nativeUsageMaxSessions, type NativeUsage } from "./native-usage-contract.ts";

// One turn leaves its success row and any failed attempts before it; more than this is not one turn.
const rowsPerSession = 20;

/** The canonical sessions a device usage read names, and nothing else. */
export async function nativeUsageSessions(url: URL): Promise<string[]> {
  const raw = url.searchParams.getAll("session");
  if (
    !raw.length ||
    raw.length > nativeUsageMaxSessions ||
    [...url.searchParams.keys()].some((name) => name !== "session")
  )
    return fail(400, "invalid_query", `Name 1 to ${nativeUsageMaxSessions} sessions only.`);
  return [...new Set(await Promise.all(raw.map(usageSession)))];
}

/**
 * Rows of these sessions charged to this device's key, each with whether its account is in the
 * device's pool. Home looks each session up by its session index and filters by the key; a row that
 * disagrees with either is dropped here, so another key's rows never leave this function. Each row's
 * key is Home's own, so a caller checking it tests this filter rather than restating the device's key.
 */
export async function readNativeUsage(
  client: HomeClient,
  device: { readonly pool: string; readonly keyId: number },
  sessions: readonly string[],
): Promise<NativeUsage> {
  const read = async (session: string) => {
    const query = new URLSearchParams({
      session_id: session,
      client_key_id: String(device.keyId),
      limit: String(rowsPerSession),
      offset: "0",
      sort: "timestamp_desc",
    });
    const page = await client.data(`/usage/records?${query}`);
    const items = rows(page.items);
    const total = page.total;
    if (
      items.length > rowsPerSession ||
      typeof total !== "number" ||
      !Number.isSafeInteger(total) ||
      total < 0
    )
      return unavailable();
    const records = items.flatMap((row) => {
      const key = object(row.client) ? row.client.api_key_id : undefined;
      if (row.session_id !== session || key !== device.keyId) return [];
      const id = text(row.id),
        status = text(row.status),
        at = text(row.timestamp);
      if (!id || !status || !at || !Number.isFinite(Date.parse(at))) return unavailable();
      const account = object(row.credential) ? text(row.credential.credential_id) : null;
      return [{ id, status, at, key, account }];
    });
    return { session, complete: total <= items.length, records };
  };
  const found = await mapBounded(sessions, read);
  // Most reads come before a turn's rows land; membership is read only once a row names an account.
  const members = found.some(({ records }) => records.some(({ account }) => account !== null))
    ? new Set(
        (await new PoolHome(client, device.pool).membership()).members.map(
          ({ auth_id }) => auth_id,
        ),
      )
    : new Set<string>();
  return {
    key: device.keyId,
    sessions: found.map(({ records, ...session }) => ({
      ...session,
      records: records.map(({ account, ...record }) => {
        const inPool = account !== null && members.has(account);
        return { ...record, account: inPool ? account : null, inPool };
      }),
    })),
  };
}
