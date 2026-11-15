import { createHash } from "node:crypto";

export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
    return Object.fromEntries(
      Object.entries(entry).sort(([left], [right]) => left.localeCompare(right, "en")),
    );
  });
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
