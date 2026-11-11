import { digest } from "../backend-users.ts";
import {
  historyObject,
  identifier,
  invalidHistory,
  reference,
  type ModelRequest,
} from "./record.ts";

export interface ImportAccountMapping {
  sourceAccountRef: string;
  targetAccountId: string;
  provider: string;
}

export interface ImportAccountTarget {
  id: string;
  provider: string;
}

export function importAccountMappings(raw: unknown): ImportAccountMapping[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 500) return invalidHistory();
  const seen = new Set<string>();
  return raw.map((item) => {
    const value = historyObject(item);
    if (
      typeof value.sourceAccountRef !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.sourceAccountRef) ||
      seen.has(value.sourceAccountRef)
    )
      return invalidHistory();
    seen.add(value.sourceAccountRef);
    return {
      sourceAccountRef: value.sourceAccountRef,
      targetAccountId: identifier(value.targetAccountId, true)!,
      provider: identifier(value.provider, true)!,
    };
  });
}

export function verifyImportAccountTargets(
  mappings: readonly ImportAccountMapping[],
  targets: readonly ImportAccountTarget[],
) {
  for (const mapping of mappings)
    if (
      !targets.some(
        (target) => target.id === mapping.targetAccountId && target.provider === mapping.provider,
      )
    )
      return invalidHistory();
}

/** The foreign event identity stays intact; only an explicit account binding joins native cards. */
export async function mapImportAccounts(
  records: readonly ModelRequest[],
  source: string,
  mappings: readonly ImportAccountMapping[],
): Promise<ModelRequest[]> {
  if (!mappings.length) return [...records];
  const home = await digest("home-local-v1");
  const bindings = new Map(
    await Promise.all(
      mappings.map(
        async (mapping) =>
          [
            await reference(source, "account", mapping.sourceAccountRef),
            {
              account: await reference(home, "account", mapping.targetAccountId),
              provider: mapping.provider,
            },
          ] as const,
      ),
    ),
  );
  return records.map((row) => {
    const binding = bindings.get(row.account);
    if (!binding) return row;
    if (binding.provider !== row.provider) return invalidHistory();
    return { ...row, account: binding.account };
  });
}
