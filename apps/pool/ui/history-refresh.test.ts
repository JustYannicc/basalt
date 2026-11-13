import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryState, LoadedHistory, Settled } from "./history-data.ts";
import { settleRefresh } from "./history-refresh.ts";

const request = {};
const failed = "Couldn't confirm the latest changes. Showing the last confirmed version.";

/** A loaded history whose records and totals belong to `owner`'s grant. */
function loaded(owner: string, records: number, seriesUnavailable?: string): LoadedHistory {
  return {
    bounds: { from: "2026-11-01T00:00:00.000Z", to: "2026-11-13T00:00:00.000Z" },
    firstAt: records === 0 ? null : "2026-11-01T00:00:00.000Z",
    series: { groups: [{ owner }], asOf: null, changed: false, partial: false },
    ...(seriesUnavailable === undefined ? {} : { seriesUnavailable }),
    records: Array.from({ length: records }, (_, index) => ({ id: `${owner}-${index}` })),
    next: records > 10 ? { after: `${owner}-cursor` } : null,
  } as unknown as LoadedHistory;
}

/** A manager who paged past the first page of everyone's requests. */
const pagedManager: HistoryState = {
  request,
  loaded: loaded("everyone", 25),
  loadingNext: false,
  page: 2,
};

test("a paged manager demoted to member sees only the member's newly authorized snapshot", () => {
  const member: Settled = { loaded: loaded("member", 3, "managers only") };
  const settled = settleRefresh(pagedManager, member, {
    request,
    paged: true,
    reset: true,
    failed,
  });
  assert.equal(settled.loaded, (member as { loaded: LoadedHistory }).loaded);
  assert.equal(settled.page, 0, "the old cursor and page are gone");
  assert.equal(settled.newer, undefined);
  assert.ok(
    settled.loaded?.records.every((record) => (record as { id: string }).id.startsWith("member")),
    "no other person's request survives the demotion",
  );
});

test("an empty member snapshot still replaces paged manager data", () => {
  const empty: Settled = { loaded: loaded("member", 0, "managers only") };
  const settled = settleRefresh(pagedManager, empty, { request, paged: true, reset: true, failed });
  assert.equal(settled.loaded?.records.length, 0);
  assert.equal(settled.page, 0);
});

test("an accepted failure during an authority reset keeps nothing from the old grant", () => {
  const settled = settleRefresh(
    pagedManager,
    { loadError: "History could not be read. Try again." },
    { request, paged: true, reset: true, failed },
  );
  assert.equal(settled.loaded, undefined);
  assert.equal(settled.loadError, "History could not be read. Try again.");
});

test("new usage keeps a paged person's place and says newer usage arrived", () => {
  const settled = settleRefresh(
    pagedManager,
    { loaded: loaded("everyone", 30) },
    { request, paged: true, reset: false, failed },
  );
  assert.equal(settled.loaded, pagedManager.loaded);
  assert.equal(settled.page, 2);
  assert.equal(settled.newer, true);
});

test("an unpaged person gets new usage in place, and a failed read is labelled over kept data", () => {
  const first: HistoryState = { ...pagedManager, page: 0 };
  const fresh: Settled = { loaded: loaded("everyone", 30) };
  assert.equal(
    settleRefresh(first, fresh, { request, paged: false, reset: false, failed }).loaded,
    (fresh as { loaded: LoadedHistory }).loaded,
  );
  const kept = settleRefresh(
    first,
    { loadError: "x" },
    { request, paged: false, reset: false, failed },
  );
  assert.equal(kept.loaded, first.loaded);
  assert.equal(kept.failed, failed);
});

test("a narrower response replaces paged manager data even before the authority hint is seen", () => {
  const member: Settled = { loaded: loaded("member", 0, "managers only") };
  const settled = settleRefresh(pagedManager, member, {
    request,
    paged: true,
    reset: false,
    failed,
  });
  assert.equal(settled.loaded, (member as { loaded: LoadedHistory }).loaded);
  assert.equal(settled.page, 0);
  assert.equal(settled.newer, undefined, "a narrowed grant is never shown as 'newer usage'");
});
