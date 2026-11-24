import { resolve } from "node:path";

/**
 * The entry moves into the cloud app before Alchemy loads, so the flags that name a file are
 * resolved first, against the directory the command was started in (the release runs from the repo
 * root). The flags are named by the caller's own option keys, so renaming an option breaks the
 * build instead of leaving its flag unresolved. An empty value is left alone: the commands treat it
 * as "not given".
 */
export function resolvePathFlags<V extends object>(
  values: V,
  flags: readonly (keyof V & string)[],
  cwd: string,
) {
  const record = values as Record<string, unknown>;
  for (const flag of flags) {
    const value = record[flag];
    if (typeof value === "string" && value !== "") record[flag] = resolve(cwd, value);
  }
}
