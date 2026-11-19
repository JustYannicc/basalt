/**
 * How failures hold one another: what each wraps and what a collection holds. Every read goes
 * through here, because a failure can be any value, a hostile object among them, and a failure to
 * read one must never end the report on the failure it belongs to.
 */

export const field = (value: unknown, key: string): unknown => {
  try {
    return (typeof value === "object" || typeof value === "function") && value !== null
      ? Reflect.get(value, key)
      : undefined;
  } catch {
    return undefined;
  }
};

/** `instanceof` for a failure that may be a hostile object, whose traps must not end the report. */
export const isA = <T>(value: unknown, type: abstract new (...args: never[]) => T): value is T => {
  try {
    return value instanceof type;
  } catch {
    return false;
  }
};

const memberLimit = 1000;

function held(error: unknown): unknown[] {
  const list = field(error, "errors") ?? field(error, "reasons");
  return Array.isArray(list) ? list : [];
}

/** A collection holds more failures than `members` reads, so what it says about them is partial. */
export const heldInPart = (error: unknown): boolean => {
  try {
    return held(error).length > memberLimit;
  } catch {
    return true;
  }
};

/**
 * The failures a collection holds: an `AggregateError`'s errors or an Effect cause's reasons, each
 * of which wraps its failure (`Fail` an `error`, `Die` a `defect`). Anything an AggregateError
 * holds is a failure. Another object's `errors` can be a provider's list of `{ code, message }`
 * entries, so there a member is an `Error` or carries a tag.
 */
export function members(error: unknown): unknown[] {
  try {
    const all = isA(error, AggregateError);
    return held(error)
      .slice(0, memberLimit)
      .filter((entry) => all || isA(entry, Error) || typeof field(entry, "_tag") === "string")
      .map((entry) => {
        const tag = field(entry, "_tag");
        if (tag === "Fail") return field(entry, "error") ?? entry;
        return tag === "Die" ? (field(entry, "defect") ?? entry) : entry;
      });
  } catch {
    return [];
  }
}

/** What a failure wraps. Effect's HTTP client keeps fetch's error under its reason. */
const wrapped = (error: unknown): unknown =>
  field(field(error, "reason"), "cause") ??
  field(error, "cause") ??
  field(error, "error") ??
  field(error, "defect");

const chainLimit = 10;

function walk(error: unknown, limit: number): unknown[] {
  const found: unknown[] = [];
  for (
    let current = error;
    current !== undefined && current !== null && found.length < limit && !found.includes(current);
    current = wrapped(current) ?? members(current)[0]
  )
    found.push(current);
  return found;
}

/** The failure and what it wraps, outermost first. A collection is followed through its first member. */
export const rawChain = (error: unknown): unknown[] => walk(error, chainLimit);

/** The chain goes on past what `rawChain` reads. */
export const chainCut = (error: unknown): boolean =>
  walk(error, chainLimit + 1).length > chainLimit;

/** A value whose own fields cannot be read: what it holds is unknown, which is not nothing. */
export function unreadable(value: unknown): boolean {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  try {
    for (const key of ["reason", "cause", "error", "defect", "reasons"]) Reflect.get(value, key);
    const list = Reflect.get(value, "errors") ?? Reflect.get(value, "reasons");
    if (Array.isArray(list)) list.slice(0, memberLimit);
    return false;
  } catch {
    return true;
  }
}

/** Every failure reachable from one, outermost first: what each wraps and each member of a collection. */
export function reach(error: unknown): unknown[] {
  const found: unknown[] = [];
  const queue = [error];
  while (queue.length > 0 && found.length < 64) {
    const current = queue.shift();
    if (current === undefined || current === null || found.includes(current)) continue;
    found.push(current);
    queue.push(wrapped(current), ...members(current));
  }
  return found;
}
