import {
  decodeSelectedAccountView,
  type AccountCheckContext,
  type AuthMethods,
  type SelectedAccountView,
} from "apps";
import type { AppCalls } from "apps/contracts";
import type { Account, PoolView, Provider } from "./contract.ts";
type ReadAccount = Pick<AccountCheckContext<AuthMethods>["account"], "id" | "read">;
interface Context {
  readonly app: {
    readonly accounts: Readonly<Record<string, ReadAccount | readonly ReadAccount[]>>;
  };
  readonly apps: AppCalls;
}

/** Provider presentation comes only from the exact saved source, never a similar app's name. */
export async function providerAccountView(ctx: Context, view: PoolView): Promise<PoolView> {
  const selected = Object.entries(ctx.app.accounts).flatMap(([slot, accounts]) =>
    slot === "pool" ? [] : "read" in accounts ? [accounts] : accounts,
  );
  const ids = [
    ...new Set(
      view.accounts.flatMap((account) =>
        typeof account.nativeAccountId === "string" ? [account.nativeAccountId] : [],
      ),
    ),
  ];
  const reads = new Map<string, SelectedAccountView>();
  const resolved = new Set<string>();
  for (let start = 0; start < ids.length; start += 8) {
    await Promise.all(
      ids.slice(start, start + 8).map(async (id) => {
        const account = selected.find((candidate) => candidate.id === id);
        if (account === undefined) return;
        try {
          const binding = await account.read();
          if (binding.state === "denied") {
            reads.set(id, binding);
            return;
          }
          // Unresolved source choices retain today's presentation. They never choose a first match.
          const source = binding.sourceConnection;
          if (source === undefined) {
            if (!binding.canInspect) reads.set(id, binding);
            return;
          }
          if (source.account !== account.id) throw new Error("The source selection changed");
          const value = decodeSelectedAccountView(
            await ctx.apps.call({
              connection: source.connection,
              target: source.target,
              tool: "accountView",
              kind: "query",
              input: { account: source.account },
            }),
          );
          if (
            value.account.id !== account.id ||
            (value.state === "available" && value.sourceApp.id !== source.target)
          )
            throw new Error("The source account view changed");
          reads.set(id, value);
          resolved.add(id);
        } catch {
          // A refused or interrupted source read must not reveal its old allowance via a fallback.
          reads.set(id, { state: "denied", account: { id: account.id } });
        }
      }),
    );
  }
  const accounts = view.accounts.map((account): Account => {
    if (account.nativeAccountId === undefined) return account;
    if (account.nativeAccountId === null) return withheldAccount(account);
    const nativeView = reads.get(account.nativeAccountId);
    const bound = selected.some((candidate) => candidate.id === account.nativeAccountId);
    if (nativeView === undefined)
      return bound ? account : withheldAccount({ ...account, nativeAccountId: null });
    const attached = { ...account, nativeView };
    if (nativeView.state === "denied" || !nativeView.canInspect) return withheldAccount(attached);
    return { ...attached, label: nativeView.account.label };
  });
  const providers = view.providers.map((provider): Provider => {
    const sources = accounts.flatMap((account) =>
      account.provider === provider.id &&
      account.nativeView?.state === "available" &&
      account.nativeAccountId !== undefined &&
      account.nativeAccountId !== null &&
      resolved.has(account.nativeAccountId)
        ? [account.nativeView.sourceApp]
        : [],
    );
    const source = sources[0];
    if (source === undefined) return provider;
    const presentation = JSON.stringify([source.name, source.icons ?? []]);
    // Several instances can serve one lab. A conflicting brand has no single honest lab mark.
    if (!sources.every((entry) => JSON.stringify([entry.name, entry.icons ?? []]) === presentation))
      return provider;
    return {
      ...provider,
      name: source.name,
      ...(source.icons === undefined ? {} : { icons: source.icons }),
    };
  });
  return { ...view, accounts, providers };
}

/** Keep membership and credential/routing state while withholding identity and allowance data. */
function withheldAccount(account: Account): Account {
  const { collection: _collection, usageCredits: _credits, ...member } = account;
  return {
    ...member,
    label: account.nativeView?.state === "available" ? account.nativeView.account.label : "Account",
    plan: null,
    windows: [],
    observedAt: null,
    staleAt: null,
    freshness: "never",
    readingFailed: false,
    nextReadAt: null,
    earliestResetAt: null,
    bankedResets: null,
  };
}
