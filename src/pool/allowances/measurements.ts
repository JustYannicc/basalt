import { vendorPlan, type PlanAllowance } from "apps";
import type { HomeClient } from "../control.ts";
import type { UsageStorage } from "../usage-storage.ts";
import type { QuotaObservation } from "../quota-observation.ts";
import { capacityReadings } from "../capacity/normalize.ts";
import { mapBounded } from "../bounded.ts";
import { object, text } from "../json.ts";
import { readUsagePage, type UsageScan } from "../usage-feed.ts";
import { recordTokens } from "../usage-summary.ts";
import {
  calibrationInterval,
  calibratedAllowance,
  type AllowanceObservation,
  type CalibrationSample,
  type MeasuredConsumption,
} from "./calibration.ts";

interface WindowState {
  last: AllowanceObservation;
  pending?: readonly [AllowanceObservation, AllowanceObservation];
  samples: CalibrationSample[];
  allowance?: PlanAllowance;
}
interface Consumption {
  events: readonly MeasuredConsumption[];
  rejected: readonly { account: string; at: number }[];
}
interface AccountInput {
  id: string;
  provider: string;
  quota: QuotaObservation;
}
const key = (account: string) => `pool-account-allowance-v1:${account}`;

/** Independent account measurements are shared across pools, never inferred from API prices. */
export class AccountAllowanceMeasurements {
  private storage: UsageStorage;
  private home: Pick<HomeClient, "data">;
  constructor(storage: UsageStorage, home: Pick<HomeClient, "data">) {
    this.storage = storage;
    this.home = home;
  }

  async observe(
    accounts: readonly AccountInput[],
    now: number,
  ): Promise<Map<string, readonly PlanAllowance[]>> {
    const states = new Map(
      await mapBounded(
        accounts,
        async (account) =>
          [account.id, (await this.storage.get<WindowState[]>(key(account.id))) ?? []] as const,
      ),
    );
    const pending = [...states.values()].flatMap((windows) =>
      windows.flatMap((window) =>
        window.pending &&
        window.pending[1].at <= now - 60_000 &&
        window.pending[0].at >= now - 3_600_000
          ? [window.pending]
          : [],
      ),
    );
    const events = pending.length
      ? await this.consumption(
          Math.min(...pending.map(([left]) => left.at)),
          Math.max(...pending.map(([, right]) => right.at)),
        )
      : null;
    const result = new Map<string, readonly PlanAllowance[]>();
    await mapBounded(accounts, async (account) => {
      const plan = vendorPlan(account.provider, account.quota.plan?.name ?? null);
      const old = states.get(account.id)!;
      const next: WindowState[] = [];
      for (const reading of capacityReadings(account.id, account.provider, account.quota, now, {
        entries: [],
      })) {
        if (reading.source === "reported-absolute" || reading.resetAt === null) continue;
        const right: AllowanceObservation = {
          account: account.id,
          vendor: plan.vendor,
          plan: plan.id,
          windowSeconds: reading.windowSeconds,
          mode: reading.mode,
          at: reading.observedAt,
          resetAt: reading.resetAt,
          remaining: reading.remaining / reading.full,
        };
        const previous = old.find((state) => state.last.windowSeconds === right.windowSeconds);
        const compatible =
          previous &&
          previous.last.vendor === right.vendor &&
          previous.last.plan === right.plan &&
          previous.last.mode === right.mode &&
          previous.last.resetAt === right.resetAt &&
          previous.last.remaining >= right.remaining &&
          right.at >= previous.last.at;
        const state: WindowState = compatible
          ? { ...previous, samples: [...previous.samples] }
          : { last: right, samples: [] };
        if (state.pending && state.pending[1].at <= now - 60_000) {
          const [left, right] = state.pending;
          const rejected = events?.rejected.some(
            (event) =>
              event.account === right.account && event.at >= left.at && event.at < right.at,
          );
          const sample = events && !rejected && calibrationInterval(left, right, events.events);
          if (sample) {
            if (state.samples.some((value) => value.profile !== sample.profile)) state.samples = [];
            state.samples = [
              ...state.samples.filter(
                (value) => value.to <= sample.from && now - value.to < 86_400_000,
              ),
              sample,
            ].slice(-24);
          } else {
            // Missing or contradictory consumption invalidates the estimate, not just this interval.
            state.samples = [];
            delete state.allowance;
          }
          delete state.pending;
        }
        if (
          compatible &&
          right.at > previous.last.at &&
          !state.pending &&
          previous.last.remaining > right.remaining
        ) {
          state.pending = [previous.last, right];
        }
        state.last = right;
        const allowance = calibratedAllowance({
          vendor: plan.vendor,
          plan: plan.id,
          windowSeconds: reading.windowSeconds,
          samples: state.samples,
          now,
          previous: state.allowance,
        });
        if (allowance)
          state.allowance = {
            ...allowance,
            expiresAt: Math.min(allowance.expiresAt!, right.resetAt),
          };
        else delete state.allowance;
        next.push(state);
      }
      await this.storage.put(key(account.id), next);
      result.set(
        account.id,
        next.flatMap((state) => (state.allowance ? [state.allowance] : [])),
      );
    });
    return result;
  }

  private async consumption(from: number, to: number): Promise<Consumption | null> {
    try {
      const capabilities = await this.home.data("/capabilities");
      if (
        !object(capabilities.capabilities) ||
        capabilities.capabilities.usage_summary_cursor_v1 !== true ||
        capabilities.capabilities.usage_token_breakdown_v2 !== true
      )
        return null;
      const scan: UsageScan = { from, to, offset: 0, keyset: true };
      const events = new Map<string, MeasuredConsumption>();
      const rejected: { account: string; at: number }[] = [];
      for (let page = 0; page < 5; page++) {
        const result = await readUsagePage(this.home, scan, true);
        for (const row of result.items) {
          const account = object(row.credential) ? text(row.credential.credential_id) : null;
          const at = Date.parse(text(row.timestamp) ?? "");
          const id = text(row.id);
          if (!account || !id || !Number.isFinite(at) || at < from || at >= to) return null;
          const tier = text(row.service_tier),
            model = text(row.model),
            provider = text(row.provider);
          const breakdown = row.token_breakdown;
          if (
            !tier ||
            ["unknown", "unspecified", "auto"].includes(tier.toLowerCase()) ||
            !model ||
            !provider ||
            !object(breakdown) ||
            breakdown.quality !== "complete" ||
            !object(breakdown.input) ||
            !object(breakdown.output) ||
            [
              breakdown.input.uncached_tokens,
              breakdown.input.cache_read_tokens,
              breakdown.input.cache_write_tokens,
              breakdown.output.total_tokens,
              breakdown.total_tokens,
            ].some(
              (value) => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0,
            )
          ) {
            rejected.push({ account, at });
            continue;
          }
          const tokens = recordTokens(row, true);
          if (
            tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output !==
            tokens.total
          ) {
            rejected.push({ account, at });
            continue;
          }
          const event = {
            account,
            at,
            model,
            vendor: vendorPlan(provider, null).vendor,
            tier,
            tokens,
          };
          const previous = events.get(id);
          if (previous && JSON.stringify(previous) !== JSON.stringify(event)) return null;
          events.set(id, event);
        }
        if (result.complete) return { events: [...events.values()], rejected };
      }
    } catch {
      /* A later complete interval can establish a new estimate. */
    }
    return null;
  }
}
