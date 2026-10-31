const prefix = "sbhrefs1:";

/** A Gemini sign-in can return a parent and several project credentials for one saved account. */
export function homeReferences(reference: string): readonly string[] {
  const value: unknown = reference.startsWith(prefix) ? JSON.parse(reference.slice(prefix.length)) : [reference];
  if (!Array.isArray(value) || value.length === 0 || value.length > 32
    || !value.every((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 256 && !id.startsWith(prefix))
    || new Set(value).size !== value.length)
    throw new Error("Invalid Home account reference");
  return value;
}

export function homeReference(ids: readonly string[]): string {
  const unique = [...new Set(ids)].sort();
  const reference = unique.length === 1 ? unique[0]! : `${prefix}${JSON.stringify(unique)}`;
  homeReferences(reference);
  return reference;
}
