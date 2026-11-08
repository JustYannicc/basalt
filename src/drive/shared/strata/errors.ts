export class DriveError extends Error {
  constructor(
    public readonly code: "invalid" | "stale" | "integrity" | "capacity" | "missing" | "contended",
    message: string,
  ) {
    super(message);
    this.name = "DriveError";
  }
}

export function oid(value: string) {
  if (!/^[0-9a-f]{40}$/.test(value))
    throw new DriveError("invalid", "Expected a Git SHA-1 object id");
  return value;
}

export function operation(value: string) {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127}$/.test(value))
    throw new DriveError("invalid", "Invalid operation id");
  return value;
}

export function writerRef(value: string) {
  if (!/^refs\/heads\/writers\/[A-Za-z0-9_-]{1,80}$/.test(value))
    throw new DriveError("invalid", "Expected a writer branch");
  return value;
}

export function filePath(value: string) {
  const parts = value.split("/");
  if (
    !value ||
    value.length > 1024 ||
    parts.length > 32 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value !== value.normalize("NFC") ||
    parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
  ) {
    throw new DriveError(
      "invalid",
      "Expected a normalized relative file path outside Git metadata",
    );
  }
  return parts;
}
