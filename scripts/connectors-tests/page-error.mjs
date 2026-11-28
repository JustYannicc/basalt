/**
 * An uncaught page error, reduced to what may leave the runner in a public artifact: the kind of
 * error, from a fixed list, and the first stack frame served from the dashboard's own origin, as
 * function name, bundle file name, line and column. Both come from the browser's structured report
 * of the exception (CDP `Runtime.exceptionThrown`), never from its message or printed stack, so
 * nothing the error says can pose as a frame.
 */
const names = new Set([
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  // Chromium reports every DOMException under this class name, never its specific kind.
  "DOMException",
]);
const fn = /^[A-Za-z_$][\w$]{0,63}$/;
const file = /^[A-Za-z0-9._-]{1,128}\.m?js$/;
const position = (n) => Number.isSafeInteger(n) && n > 0 && n <= 1_000_000_000;

const nameOf = (value) => (typeof value === "string" && names.has(value) ? value : "other");

/**
 * `details` is a `Runtime.exceptionThrown` event's `exceptionDetails`; `origin` is the dashboard's,
 * such as `http://127.0.0.1:4321`. Frames from other origins, and code without a URL, are skipped.
 */
export function closedPageError(details, origin) {
  const record = { name: nameOf(details?.exception?.className) };
  const frames = details?.stackTrace?.callFrames;
  for (const call of Array.isArray(frames) ? frames : []) {
    let url;
    try {
      url = new URL(call?.url);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    const base = url.pathname.split("/").at(-1) ?? "";
    // CDP counts lines and columns from zero.
    const line = Number(call.lineNumber) + 1,
      column = Number(call.columnNumber) + 1;
    if (!file.test(base) || !position(line) || !position(column)) continue;
    return {
      ...record,
      frame: {
        ...(typeof call.functionName === "string" && fn.test(call.functionName)
          ? { function: call.functionName }
          : {}),
        file: base,
        line,
        column,
      },
    };
  }
  return record;
}

/**
 * The same fields read back from a proof's file, checked again for their shape only: a file can't
 * show where a value came from, so this keeps it to listed names, identifiers and numbers.
 */
export function revalidatedPageErrors(value) {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 5).map((entry) => {
    const recorded = entry?.frame;
    return {
      name: nameOf(entry?.name),
      ...(recorded &&
      typeof recorded.file === "string" &&
      file.test(recorded.file) &&
      position(recorded.line) &&
      position(recorded.column)
        ? {
            frame: {
              ...(typeof recorded.function === "string" && fn.test(recorded.function)
                ? { function: recorded.function }
                : {}),
              file: recorded.file,
              line: recorded.line,
              column: recorded.column,
            },
          }
        : {}),
    };
  });
}
