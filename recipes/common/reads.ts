import type { WorkflowStepContext, MutationContext } from "apps";
import { requirements } from "./installation.ts";
import { api, instant, list, numeric, ReadUnavailable, record, text, tool } from "./api.ts";
import { configuration } from "./configuration.ts";
import { connectionObservation, poolObservation, type PoolFact } from "./conditions.ts";
import type { Checkpoint, Observation } from "./types.ts";
type Step = WorkflowStepContext<typeof requirements>;
const unknown = (at: number, code: string): Observation => ({
  cursor: `${code}:${at}`,
  at,
  verdict: "unknown",
  code,
  failures: 0,
  successes: 0,
  since: at,
});

export async function connectionTargets(context: MutationContext<typeof requirements>) {
  if (configuration.accounts.length) return [...new Set(configuration.accounts)];
  const inventory = record(await api(context, "GET", "inventory"));
  if (!Array.isArray(inventory?.accounts)) throw new Error("Account inventory is unavailable.");
  return inventory.accounts.flatMap((value) => {
    const account = record(value),
      health = record(account?.health);
    return typeof account?.id === "string" &&
      list(health?.apps).some((entry) => record(entry)?.checkable === true)
      ? [account.id]
      : [];
  });
}
export async function readConnection(context: Step, id: string): Promise<Observation> {
  const now = Date.now();
  try {
    const detail = record(await api(context, "GET", `accounts/${encodeURIComponent(id)}`));
    if (detail?.canReconnect !== true && detail?.canManage !== true)
      return { ...unknown(now, "not-connection-owner"), verdict: "withdraw" };
    await api(context, "POST", `accounts/${encodeURIComponent(id)}/health`);
    const current = record(await api(context, "GET", `accounts/${encodeURIComponent(id)}`));
    const checks = list(record(current?.health)?.apps).flatMap((value) => {
      const entry = record(value),
        check = record(entry?.check),
        at = instant(check?.checkedAt);
      return entry?.checkable === true &&
        check?.current === true &&
        at !== undefined &&
        at <= now + 10000 &&
        now - at <= 30 * 60000
        ? [{ status: text(check.status), at }]
        : [];
    });
    const rejected = checks.find((check) => check.status === "credentials_rejected");
    const forbidden = checks.find((check) => check.status === "forbidden");
    const selected = current?.canReconnect === true ? (rejected ?? forbidden) : forbidden;
    const allChecks = list(record(current?.health)?.apps).filter(
      (value) => record(value)?.checkable === true,
    );
    const healthy =
      checks.length > 0 &&
      checks.length === allChecks.length &&
      checks.every((check) => check.status === "healthy");
    const at = selected?.at ?? Math.max(0, ...checks.map((check) => check.at));
    return connectionObservation({
      id,
      at: at || now,
      current: selected !== undefined || healthy,
      status: selected?.status ?? (healthy ? "healthy" : "unknown"),
      canManage: current?.canManage === true,
      canReconnect: current?.canReconnect === true,
      checkable: checks.length > 0,
    });
  } catch (error) {
    return {
      ...unknown(now, "connection-read-unavailable"),
      verdict:
        error instanceof ReadUnavailable && [403, 404].includes(error.status)
          ? "withdraw"
          : "unknown",
    };
  }
}
export async function readPool(
  context: Step,
  app: string,
  provider: string,
): Promise<PoolFact | null> {
  try {
    const result = record(await tool(context, { app, tool: "view", input: {} }));
    const view = record(result?.value);
    if (
      result?.ok === false &&
      ["not_owner", "forbidden", "not_member"].includes(text(result.error) ?? "")
    )
      throw new ReadUnavailable(403);
    if (
      result?.ok !== true ||
      typeof view?.isOwner !== "boolean" ||
      !Array.isArray(view.accounts) ||
      view.accounts.length > 100
    )
      return null;
    if (
      view.accounts.some((value) => {
        const account = record(value);
        return (
          typeof account?.id !== "string" ||
          !account.id ||
          account.id.length > 200 ||
          typeof account.provider !== "string" ||
          !["active", "disabled", "unavailable", "error"].includes(text(account.state) ?? "")
        );
      })
    )
      return null;
    if (new Set(view.accounts.map((value) => record(value)!.id)).size !== view.accounts.length)
      return null;
    const removals = record(view.removals);
    const removalItems = list(removals?.items);
    const historyValid =
      removals !== undefined &&
      Array.isArray(removals.items) &&
      removalItems.length <= 100 &&
      (removals.since === null || instant(removals.since) !== undefined) &&
      removalItems.every((value) => {
        const item = record(value);
        return (
          typeof item?.account === "string" &&
          typeof item.actor === "string" &&
          instant(item.at) !== undefined
        );
      });
    return {
      at: Date.now(),
      ...(historyValid
        ? {
            removals: {
              since: instant(removals?.since) ?? null,
              items: removalItems.flatMap((value) => {
                const item = record(value)!;
                return item.actor === context.user.id
                  ? [{ id: String(item.account), at: instant(item.at)! }]
                  : [];
              }),
            },
          }
        : {}),
      owner: view.isOwner,
      provider,
      accounts: list(view.accounts).flatMap((value) => {
        const account = record(value);
        if (account?.provider !== provider || typeof account.id !== "string") return [];
        const windows = list(account.windows);
        return [
          {
            id: account.id,
            state: text(account.state) ?? "unknown",
            fresh: account.freshness === "fresh",
            failed: account.readingFailed !== false,
            observedAt: instant(account.observedAt) ?? 0,
            ...(record(account.collection)
              ? {
                  collection: {
                    status: text(record(account.collection)?.status) ?? "unknown",
                    errorCode: text(record(account.collection)?.errorCode) ?? null,
                    attemptedAt: instant(record(account.collection)?.lastAttemptAt) ?? 0,
                  },
                }
              : {}),
            windows:
              windows.length > 8
                ? []
                : windows.map((value) => {
                    const window = record(value);
                    return {
                      id: text(window?.id) ?? "unknown",
                      remaining: numeric(window?.remainingRatio) ?? null,
                      observedAt: instant(window?.observedAt) ?? null,
                      resetAt: instant(window?.resetAt) ?? null,
                    };
                  }),
          },
        ];
      }),
    };
  } catch (error) {
    if (error instanceof ReadUnavailable && [403, 404].includes(error.status)) throw error;
    return null;
  }
}
export async function readQuota(
  context: Step,
  app: string,
  provider: string,
  previous: Checkpoint,
) {
  try {
    const fact = await readPool(context, app, provider);
    if (fact !== null && !fact.owner)
      return {
        ...unknown(Date.now(), "not-pool-owner"),
        verdict: "withdraw",
      } satisfies Observation;
    return fact === null
      ? unknown(Date.now(), "pool-read-unavailable")
      : poolObservation(fact, previous);
  } catch (error) {
    return {
      ...unknown(Date.now(), "pool-read-unavailable"),
      verdict:
        error instanceof ReadUnavailable && [403, 404].includes(error.status)
          ? "withdraw"
          : "unknown",
    } satisfies Observation;
  }
}
