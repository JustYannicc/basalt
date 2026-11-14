import { digest } from "./backend-users.ts";
import { fail, object } from "./json.ts";
import type { UsageAccountLabelInput } from "../../apps/pool/usage-account-label-contract.ts";

export const importedAccountPattern = /^imported:[a-f0-9]{64}$/;
type Labels = Record<string, string>;
interface LabelTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
interface LabelStorage extends LabelTransaction {
  transaction<T>(work: (transaction: LabelTransaction) => Promise<T>): Promise<T>;
}

export function usageAccountLabelInput(raw: unknown): UsageAccountLabelInput {
  if (
    !object(raw) ||
    typeof raw.account !== "string" ||
    !importedAccountPattern.test(raw.account) ||
    (raw.label !== null &&
      (typeof raw.label !== "string" ||
        raw.label.trim().length === 0 ||
        raw.label.length > 80 ||
        Array.from(raw.label).some((character) => {
          const code = character.codePointAt(0)!;
          return code < 32 || code === 127;
        })))
  )
    return fail(400, "invalid_query", "Choose an imported account and a label of 1–80 characters.");
  return { account: raw.account, label: raw.label === null ? null : raw.label.trim() };
}

/** Display metadata lives outside the append-only ledger and never grants account access. */
export class UsageAccountLabels {
  private storage: LabelStorage;
  constructor(storage: LabelStorage) {
    this.storage = storage;
  }

  private async key(pool: string) {
    return `usage-account-labels:${await digest(pool)}`;
  }

  async read(pool: string) {
    return (await this.storage.get<Labels>(await this.key(pool))) ?? {};
  }

  async set(pool: string, raw: unknown) {
    const input = usageAccountLabelInput(raw);
    const key = await this.key(pool);
    await this.storage.transaction(async (transaction) => {
      const labels = (await transaction.get<Labels>(key)) ?? {};
      if (input.label === null) delete labels[input.account];
      else labels[input.account] = input.label;
      if (
        Object.keys(labels).length > 500 ||
        new TextEncoder().encode(JSON.stringify(labels)).byteLength > 100_000
      )
        return fail(
          400,
          "invalid_query",
          "This pool's imported-account labels exceed their limit.",
        );
      await transaction.put(key, labels);
    });
    return { success: true as const };
  }
}
