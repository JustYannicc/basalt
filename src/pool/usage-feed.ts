import type { HomeClient } from "./control.ts";
import { object, rows, text, unavailable } from "./json.ts";

export function usageTimestampOrder(a: string, b: string): number {
  const milliseconds = Date.parse(a) - Date.parse(b);
  if (milliseconds !== 0) return milliseconds;
  const fraction = (at: string) => (/\.(\d+)/.exec(at)?.[1] ?? "").padEnd(9, "0");
  return fraction(a).localeCompare(fraction(b));
}

export interface UsageScan {
  from: number;
  to: number;
  offset: number;
  keyset?: boolean;
  after?: { timestamp: string; id: string };
}

/** Restart an old offset once when changing readers; durable receipts deduplicate it. */
export async function readUsagePage(
  home: Pick<HomeClient, "data">,
  scan: UsageScan,
  keyset: boolean,
) {
  if (Boolean(scan.keyset) !== keyset) {
    scan.offset = 0;
    delete scan.after;
    scan.keyset = keyset;
  }
  const params = new URLSearchParams({
    from: new Date(scan.from).toISOString(),
    to: new Date(scan.to).toISOString(),
    limit: "200",
  });
  if (keyset) {
    if (scan.after) {
      params.set("after_timestamp", scan.after.timestamp);
      params.set("after_id", scan.after.id);
    }
  } else {
    params.set("sort", "timestamp_asc");
    params.set("offset", String(scan.offset));
  }
  const page = await home.data(`/usage/${keyset ? "summary-records" : "records"}?${params}`);
  const items = rows(page.items);
  if (!Array.isArray(page.items) || items.length !== page.items.length || items.length > 200)
    return unavailable();
  let complete: boolean;
  if (keyset) {
    complete = page.next === null;
    if (!complete) {
      if (!object(page.next) || !items.length) return unavailable();
      const timestamp = text(page.next.timestamp),
        id = text(page.next.id),
        last = items.at(-1)!;
      if (
        !timestamp ||
        !id ||
        !/^[1-9][0-9]*$/.test(id) ||
        !Number.isFinite(Date.parse(timestamp)) ||
        last.timestamp !== timestamp ||
        last.id !== id ||
        (scan.after?.timestamp === timestamp && scan.after.id === id)
      )
        return unavailable();
      // Keep the source's sub-millisecond precision through storage and the next request.
      scan.after = { timestamp, id };
    }
  } else {
    if (
      typeof page.total !== "number" ||
      !Number.isSafeInteger(page.total) ||
      page.total < 0 ||
      (!items.length && scan.offset < page.total)
    )
      return unavailable();
    complete = scan.offset + items.length >= page.total;
  }
  scan.offset += items.length;
  return { items, complete };
}

export async function readPendingUsagePage(home: Pick<HomeClient, "data">, to: number) {
  const page = await home.data(
    `/usage/summary-pending?${new URLSearchParams({ to: new Date(to).toISOString() })}`,
  );
  const items = rows(page.items);
  if (
    !Array.isArray(page.items) ||
    items.length !== page.items.length ||
    items.length > 200 ||
    typeof page.more !== "boolean" ||
    (page.more && items.length === 0)
  )
    return unavailable();
  if (
    items.some(
      (row) =>
        !text(row.id) ||
        !/^[1-9][0-9]*$/.test(String(row.id)) ||
        !/^[a-f0-9]{32}$/.test(String(row.pending_token)),
    )
  )
    return unavailable();
  return { items, complete: !page.more };
}

export async function acknowledgeUsagePage(
  home: Pick<HomeClient, "data">,
  items: { id: string; token: string }[],
) {
  if (!items.length) return;
  const result = await home.data("/usage/summary-ack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (result.ok !== true) return unavailable();
}
