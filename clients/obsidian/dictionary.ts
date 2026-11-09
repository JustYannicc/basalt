export function dictionary<T>(entries: Iterable<readonly [string, T]> = []) {
  const value: Record<string, T> = Object.fromEntries(entries);
  Object.setPrototypeOf(value, null);
  return value;
}
