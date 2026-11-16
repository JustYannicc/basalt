export function canonicalProviderValue(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalProviderValue(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalProviderValue(item)}`)
      .join(",")}}`;
  }
  throw new Error("Unsupported provider observation value");
}

export async function providerDigest(value: unknown) {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalProviderValue(value))),
  ).toString("hex");
}
