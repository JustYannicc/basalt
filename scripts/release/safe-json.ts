/**
 * JSON for anything the entry prints or keeps. Apply resolves a plan's props in place into
 * resource objects that point back at each other, and JSON.stringify throws on the cycle; an
 * object already on the current path prints as "[cycle]" instead.
 */
export function safeJson(value: unknown, space?: number): string {
  const path: object[] = [];
  return (
    JSON.stringify(
      value,
      function (this: unknown, _key: string, current: unknown) {
        if (typeof current === "bigint") return current.toString();
        if (typeof current !== "object" || current === null) return current;
        while (path.length > 0 && path.at(-1) !== this) path.pop();
        if (path.includes(current)) return "[cycle]";
        path.push(current);
        return current;
      },
      space,
    ) ?? "null"
  );
}
