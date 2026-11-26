/**
 * An uncaught page error, reduced to what may leave the runner in a public artifact: the kind of
 * error, from a fixed list, and the first stack frame served from the dashboard's own origin, as
 * function name, bundle file name, line and column. The message, URLs, hosts and every other frame
 * stay out.
 */
// Playwright names a thrown non-Error after the text before its first colon, so a name is kept
// only when it is a built-in error class or a DOMException name.
const names = new Set([
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AbortError",
  "DataCloneError",
  "InvalidStateError",
  "NetworkError",
  "NotAllowedError",
  "NotFoundError",
  "NotSupportedError",
  "QuotaExceededError",
  "SecurityError",
  "TimeoutError",
]);
const fn = /^[A-Za-z_$][\w$.]{0,63}$/;
const file = /^[A-Za-z0-9._-]{1,128}\.m?js$/;
// Chromium's frames: "at fn (url:1:2)", "at new Fn (…)", "at Object.fn [as alias] (…)",
// "at async fn (…)", "at eval (eval at fn (…))" or "at url:1:2".
const frame =
  /^ {4}at (?:async )?(?:new )?(?:(\S+)(?: \[as \S+\])? \((?:eval at \S+ \()?)?(https?:\/\/[^\s()]+):(\d{1,9}):(\d{1,9})\)*$/;

const nameOf = (value) => (typeof value === "string" && names.has(value) ? value : "other");

/** `origin` is the dashboard's, such as `http://127.0.0.1:4321`; other origins' frames are skipped. */
export function closedPageError(error, origin) {
  const record = { name: nameOf(error?.name) };
  const stack = typeof error?.stack === "string" ? error.stack : "";
  // The stack starts with the name and message, which may run over several lines and look like
  // frames; only what follows them is read.
  const heading = `${error?.name}: ${error?.message}`;
  const frames = stack.startsWith(heading) ? stack.slice(heading.length) : "";
  for (const line of frames.split("\n")) {
    if (line.length > 1024) continue;
    const match = frame.exec(line);
    if (!match) continue;
    let url;
    try {
      url = new URL(match[2]);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    const base = url.pathname.split("/").at(-1) ?? "";
    if (!file.test(base)) continue;
    return {
      ...record,
      frame: {
        ...(match[1] && fn.test(match[1]) ? { function: match[1] } : {}),
        file: base,
        line: Number(match[3]),
        column: Number(match[4]),
      },
    };
  }
  return record;
}

/**
 * The same fields read back from a proof's file, checked again for their shape only: a file can't
 * show where a value came from, so this keeps it to names, identifiers and numbers.
 */
export function revalidatedPageErrors(value) {
  if (!Array.isArray(value)) return undefined;
  const count = (n) => Number.isSafeInteger(n) && n > 0 && n <= 1_000_000_000;
  return value.slice(0, 5).map((entry) => {
    const recorded = entry?.frame;
    return {
      name: nameOf(entry?.name),
      ...(recorded &&
      typeof recorded.file === "string" &&
      file.test(recorded.file) &&
      count(recorded.line) &&
      count(recorded.column)
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
