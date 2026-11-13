import type {
  UsageSummary,
  UsageSlice,
  ModelUsage,
  DayUsage,
} from "../../../apps/pool/contract.ts";
import { digest } from "../backend-users.ts";
import { reference } from "./record.ts";
import {
  officialCosts,
  officialCostMetric,
  officialCostTargets,
  type OfficialCostRow,
} from "./official-cost.ts";
import type { OverviewApiPrice } from "../../../apps/pool/overview-contract.ts";
import type { HistoryDatabase } from "./schema.ts";

/** Replace every USD amount, including retained buckets, from current official request-token prices. */
async function readPricedSummary(
  db: HistoryDatabase,
  input: {
    pool: string;
    caller: string;
    canManage: boolean;
    summary: UsageSummary;
  },
  prices: (
    targets: readonly { provider: string; model: string }[],
  ) => Promise<readonly OverviewApiPrice[]>,
): Promise<UsageSummary> {
  const scope = {
    pool: input.pool,
    from: input.summary.from,
    to: input.summary.to,
    includeImports: false,
    ...(!input.canManage ? { person: await digest(input.caller) } : {}),
  };
  const targets = await officialCostTargets(db, scope);
  const table = targets.unavailableReason ? [] : await prices(targets.targets);
  const rows = await officialCosts(db, scope, table);
  const money = (usage: UsageSlice, selected: readonly OfficialCostRow[]) => {
    const metric = officialCostMetric(selected, table, targets.unavailableReason);
    return {
      ...usage,
      cost: Number(metric.amount ?? "0"),
      unpriced: Math.max(0, usage.requests - metric.pricedRequests),
    };
  };
  const models = (items: readonly ModelUsage[], selected: readonly OfficialCostRow[]) =>
    items.map((model) => ({
      ...model,
      ...money(
        model,
        selected.filter((row) => row.provider === model.provider && row.model === model.model),
      ),
    }));
  const days = (items: readonly DayUsage[], selected: readonly OfficialCostRow[]) =>
    items.map((day) => {
      const own = selected.filter((row) => row.day === day.day);
      return { ...day, ...money(day, own), models: models(day.models, own) };
    });
  const source = await digest("home-local-v1");
  const summary = input.summary;
  const accountReferences = new Map(
    await Promise.all(
      summary.accounts.map(
        async (account) =>
          [account.account, await reference(source, "account", account.account)] as const,
      ),
    ),
  );
  return {
    ...summary,
    total: money(summary.total, rows),
    models: models(summary.models, rows),
    days: days(summary.days, rows),
    ...(summary.apps
      ? {
          apps: summary.apps.map((app) => ({
            ...app,
            ...money(
              app,
              rows.filter((row) => row.app === app.app && row.requirement === app.requirement),
            ),
          })),
        }
      : {}),
    accounts: await Promise.all(
      summary.accounts.map(async (account) => ({
        ...account,
        ...money(
          account,
          rows.filter((row) => row.account === accountReferences.get(account.account)),
        ),
      })),
    ),
    ...(summary.members
      ? {
          members: await Promise.all(
            summary.members.map(async (member) => {
              const person = await digest(member.member),
                own = rows.filter((row) => row.person === person);
              return {
                ...member,
                ...money(member, own),
                models: models(member.models, own),
                days: days(member.days, own),
                ...(member.apps
                  ? {
                      apps: member.apps.map((app) => ({
                        ...app,
                        ...money(
                          app,
                          own.filter(
                            (row) => row.app === app.app && row.requirement === app.requirement,
                          ),
                        ),
                      })),
                    }
                  : {}),
              };
            }),
          ),
        }
      : {}),
  };
}

/** Settings prices its entire read against one request snapshot and one official table. */
export async function pricedSummary(
  ...args: Parameters<typeof readPricedSummary>
): Promise<UsageSummary> {
  const [db] = args;
  await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const result = await readPricedSummary(...args);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
