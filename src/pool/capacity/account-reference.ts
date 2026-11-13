import { digest } from "../backend-users.ts";

/** Persisted history uses these pool-scoped references, never credential identifiers. */
export const capacityAccountReference = (pool: string, account: string) =>
  digest(`${pool}\u0000${account}`);

/** Resolve only credentials in the current trusted pool inventory. */
export async function capacityAccountReferences(pool: string, accounts: readonly string[]) {
  return new Map(
    await Promise.all(
      [...new Set(accounts)].map(
        async (account) => [await capacityAccountReference(pool, account), account] as const,
      ),
    ),
  );
}
