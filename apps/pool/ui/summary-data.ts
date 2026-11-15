import { ChangeReadRetry, type ChangeWatch, type ChangeReceipt } from "apps/client";
import { topics, capacityTopics, versionOf, withRequests } from "./summary-snapshot.ts";
import { unconfirmed } from "./pool-view.ts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PoolCapacityHistory } from "../capacity-contract.ts";
import type { PoolPersonalOverviewResult } from "../overview-contract.ts";
import type { PoolUsageSummaryResult } from "../usage-overview-contract.ts";
import type { Result } from "../index.ts";
import type { PoolApi } from "./api.ts";
import { managersOnly } from "./overview-data.ts";
import {
  personalRange,
  rangeKey,
  summaryRange,
  type Breakdown,
  type RangeChoice,
  type SummaryBounds,
} from "./summary-model.ts";

const unreachable = {
  ok: false,
  error: "backend_unavailable",
  message: "Usage could not be read. Try again.",
} as const;

export interface SummaryState {
  readonly summary?: Result<PoolUsageSummaryResult>;
  readonly capacity?: Result<PoolCapacityHistory>;
  /** Only someone the summary refuses as a non-manager gets their own usage instead. */
  readonly personal?: Result<PoolPersonalOverviewResult>;
  /** Capacity and usage end at the same instant, so one verdict can rest on both. */
  readonly coherent: boolean;
  /** The exact bounds this answer was asked for; account reads pin to them. */
  readonly bounds?: SummaryBounds;
}

/** Summary and capacity publish independently after their own accepted revision reads. */
export function useSummary(api: PoolApi, range: RangeChoice, by: Breakdown) {
  const key = rangeKey(range);
  const query = useMemo(() => ({ api, key, by }), [api, key, by]);
  const choice = useRef(range);
  useLayoutEffect(() => {
    choice.current = range;
  }, [range]);
  const [snapshot, setSnapshot] = useState<{ query: typeof query; value: SummaryState }>();
  const latest = useRef({ id: 0 });
  const watch = useRef<ChangeWatch | undefined>(undefined);
  const capacityWatch = useRef<ChangeWatch | undefined>(undefined);
  const capacityNeedsRead = useRef(false);
  const [reading, setReading] = useState<object>();
  const [failed, setFailed] = useState<{ query: typeof query; message: string }>();
  const kept = useRef<{
    api: PoolApi;
    key: string;
    bounds: SummaryBounds;
    capacity: NonNullable<SummaryState["capacity"]>;
    version: string;
  }>(undefined);
  const capacityRead = useRef<{
    api: PoolApi;
    key: string;
    bounds: SummaryBounds;
    now: number;
    controller: AbortController;
    publish: (value: NonNullable<SummaryState["capacity"]>, version: string) => void;
    reject: (error: unknown) => void;
    finish: () => void;
  }>(undefined);
  const load = useCallback(
    async (fresh = true) => {
      const current = watch.current;
      const currentCapacity = capacityWatch.current;
      if (current === undefined || currentCapacity === undefined) return;
      const pending = latest.current;
      const id = ++pending.id;
      const marker = {};
      setReading(marker);
      setFailed(undefined);
      const ongoing =
        capacityRead.current?.api === api && capacityRead.current.key === key
          ? capacityRead.current
          : undefined;
      const reuse =
        !fresh && ongoing === undefined && kept.current?.api === api && kept.current.key === key
          ? kept.current
          : undefined;
      const now = ongoing?.now ?? (reuse ? Date.parse(reuse.bounds.to) : Date.now());
      const bounds = ongoing?.bounds ?? reuse?.bounds ?? summaryRange(choice.current, now);
      let pieces: Omit<SummaryState, "coherent" | "bounds"> = reuse
        ? { capacity: reuse.capacity }
        : {};
      const versions = new Map<keyof typeof pieces, string>();
      if (reuse) versions.set("capacity", reuse.version);
      let remaining = reuse ? 1 : 2;
      const finish = () => {
        if (--remaining !== 0) return;
        setReading((value) => (value === marker ? undefined : value));
        if (id === pending.id && new Set(versions.values()).size > 1) current.request();
      };
      const publish = (next: typeof pieces, version: string) => {
        if (id !== pending.id) return;
        pieces = { ...pieces, ...next };
        for (const part of Object.keys(next) as (keyof typeof pieces)[])
          versions.set(part, version);
        const { summary, capacity } = pieces;
        if (summary === undefined) return;
        const answered =
          summary.ok && summary.value.from === bounds.from && summary.value.to === bounds.to;
        setFailed(undefined);
        setSnapshot({
          query,
          value: {
            ...pieces,
            bounds,
            capacity:
              capacity?.ok && summary.ok
                ? { ok: true, value: withRequests(capacity.value, summary.value) }
                : capacity,
            coherent:
              answered &&
              capacity?.ok === true &&
              capacity.value.to === Date.parse(bounds.to) &&
              new Set(versions.values()).size === 1,
          },
        });
      };
      const reject = (error: unknown) => {
        if (id !== pending.id || !(error instanceof ChangeReadRetry) || error.reason === "hidden")
          return;
        setFailed({ query, message: unconfirmed });
        setSnapshot(
          (previous) =>
            previous ?? { query, value: { coherent: false, bounds, summary: unreachable } },
        );
      };
      const startCapacity = () => {
        const callbacks = {
          publish: (capacity: NonNullable<SummaryState["capacity"]>, version: string) => {
            if (id === pending.id) kept.current = { api, key, bounds, capacity, version };
            publish({ capacity }, version);
          },
          reject,
          finish,
        };
        if (ongoing) Object.assign(ongoing, callbacks);
        else {
          const entry = { api, key, bounds, now, controller: new AbortController(), ...callbacks };
          capacityRead.current = entry;
          capacityNeedsRead.current = true;
          void currentCapacity
            .read(
              () => api.capacity(bounds.days, now, entry.controller.signal),
              (capacity, _version, receipt) => {
                capacityNeedsRead.current = false;
                entry.publish(capacity, versionOf(receipt));
              },
            )
            .catch((error: unknown) => entry.reject(error))
            .finally(() => {
              if (capacityRead.current === entry) capacityRead.current = undefined;
              entry.finish();
            });
        }
      };
      if (!reuse) startCapacity();
      try {
        const summary = await current.read(
          () => api.summary({ from: bounds.from, to: bounds.to, by }),
          (summary, _version, receipt) => {
            const version = versionOf(receipt);
            publish({ summary }, version);
            // A breakdown may reuse capacity only under the same accepted authority and heads.
            if (reuse && reuse.version !== version) {
              remaining++;
              startCapacity();
            }
          },
        );
        if (managersOnly(summary))
          await current.read(
            () => api.personalOverview(personalRange(choice.current, bounds, now)),
            (personal, _version, receipt) => publish({ personal }, versionOf(receipt)),
          );
      } catch (error) {
        reject(error);
      } finally {
        finish();
      }
    },
    [api, key, by, query],
  );
  useEffect(() => {
    const pending = latest.current;
    let initial = true;
    let capacityPrimed = false;
    const capacity = api.changes().watch({
      topics: capacityTopics,
      confirmed: () => {
        // A data-free head check cannot settle a capacity read parked by hiding or failure.
        if (capacityNeedsRead.current) capacity.request();
      },
      refresh: async () => {
        // Usage changes refresh both parts through load. Capacity-only changes keep usage.
        let receipt: ChangeReceipt | undefined;
        await capacity.read(
          async () => undefined,
          (_value, _version, accepted) => {
            receipt = accepted;
          },
        );
        if (!capacityPrimed) {
          capacityPrimed = true;
          return;
        }
        const previous = kept.current;
        if (
          !previous ||
          !receipt ||
          versionOf(receipt) !== previous.version ||
          capacityRead.current
        )
          return;
        const id = pending.id;
        const marker = {};
        setReading(marker);
        setFailed(undefined);
        const entry = {
          api,
          key,
          bounds: previous.bounds,
          now: Date.parse(previous.bounds.to),
          controller: new AbortController(),
          publish: (value: NonNullable<SummaryState["capacity"]>, version: string) => {
            if (id !== pending.id) return;
            kept.current = { ...previous, capacity: value, version };
            setSnapshot((snapshot) =>
              snapshot?.query === query
                ? {
                    ...snapshot,
                    value: {
                      ...snapshot.value,
                      capacity:
                        value.ok && snapshot.value.summary?.ok
                          ? {
                              ok: true,
                              value: withRequests(value.value, snapshot.value.summary.value),
                            }
                          : value,
                      coherent: snapshot.value.coherent && version === previous.version,
                    },
                  }
                : snapshot,
            );
          },
          reject: (error: unknown) => {
            if (id === pending.id && error instanceof ChangeReadRetry && error.reason !== "hidden")
              setFailed({ query, message: unconfirmed });
          },
          finish: () => setReading((value) => (value === marker ? undefined : value)),
        };
        capacityRead.current = entry;
        capacityNeedsRead.current = true;
        try {
          await capacity.read(
            () => api.capacity(entry.bounds.days, entry.now, entry.controller.signal),
            (value, _version, accepted) => {
              capacityNeedsRead.current = false;
              entry.publish(value, versionOf(accepted));
            },
          );
        } catch (error) {
          entry.reject(error);
        } finally {
          if (capacityRead.current === entry) capacityRead.current = undefined;
          entry.finish();
        }
      },
      revoked: () => {
        kept.current = undefined;
        setSnapshot(undefined);
      },
    });
    capacityWatch.current = capacity;
    const current = api.changes().watch({
      topics,
      refresh: () => {
        const fresh = !initial;
        initial = false;
        return load(fresh);
      },
      revoked: () => {
        pending.id++;
        kept.current = undefined;
        capacityRead.current?.controller.abort();
        capacityRead.current = undefined;
        setSnapshot(undefined);
      },
    });
    watch.current = current;
    return () => {
      pending.id++;
      capacityRead.current?.controller.abort();
      capacityRead.current = undefined;
      watch.current = undefined;
      current.stop();
      capacityWatch.current = undefined;
      capacity.stop();
    };
  }, [api, load, key, query]);
  const state = snapshot?.query === query ? snapshot.value : undefined;
  const shown = state ?? snapshot?.value;
  return {
    state: shown,
    updating: shown !== undefined && (state === undefined || reading !== undefined),
    by: snapshot?.query.by ?? by,
    reload: () => load(),
    member: managersOnly(shown?.summary),
    failed:
      failed?.query === query && (shown?.summary?.ok || shown?.personal?.ok)
        ? failed.message
        : undefined,
  };
}
