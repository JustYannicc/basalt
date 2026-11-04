import type { HomeClient } from "../control.ts";
import { digest } from "../backend-users.ts";
import { rows, object, text, unavailable } from "../json.ts";
import { authorizeSeries, seriesIds } from "./series-input.ts";
import { historyObject, invalidHistory } from "./record.ts";
import type { SeriesAuthority } from "./series-contract.ts";

/** Verify a newly served session without exposing Home credential references to the client. */
export async function sessionSuccess(home: HomeClient, raw: unknown, authority: SeriesAuthority) {
  const input = historyObject(raw),
    accounts = seriesIds(input.accounts);
  authorizeSeries({ accounts }, authority);
  if (typeof input.session !== "string" || !/^[0-9a-f-]{36}$/i.test(input.session))
    return invalidHistory();
  const source = await digest("home-local-v1"),
    latest = new Map<string, string>();
  const query = new URLSearchParams({ session_id: input.session, status: "success", limit: "200" });
  let offset = 0;
  if (authority.mappingProven)
    for (let page = 0; page < 5; page++) {
      query.set("offset", String(offset));
      const data = await home.data(`/usage/records?${query}`),
        items = rows(data.items);
      if (items.length > 200 || typeof data.total !== "number") return unavailable();
      for (const row of items) {
        if (row.session_id !== input.session || row.status !== "success" || !object(row.credential))
          continue;
        const reference = text(row.credential.credential_id),
          at = text(row.timestamp);
        if (!reference || !at || !Number.isFinite(Date.parse(at))) continue;
        const hash = await digest(JSON.stringify([source, "account", reference]));
        for (const account of authority.accounts)
          if (
            account.account !== null &&
            accounts.includes(account.account) &&
            account.history.includes(hash)
          ) {
            const previous = latest.get(account.account);
            if (previous === undefined || Date.parse(at) > Date.parse(previous))
              latest.set(account.account, at);
          }
      }
      offset += items.length;
      if (!items.length || offset >= data.total) break;
    }
  return {
    asOf: new Date().toISOString(),
    mapping: {
      current: true,
      historicalGenerations: "unknown",
      proof: authority.mappingProven ? "proven" : "unavailable",
    },
    accounts: accounts.map((account) => ({ account, lastSuccessAt: latest.get(account) ?? null })),
  };
}
