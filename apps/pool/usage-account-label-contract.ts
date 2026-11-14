export interface UsageAccountLabelInput {
  account: string;
  /** Null removes the display label; the imported history remains intact. */
  label: string | null;
}

export type UsageAccountDisplay =
  | { kind: "imported-only"; label: string | null }
  | { kind: "no-account-recorded"; label: null };
