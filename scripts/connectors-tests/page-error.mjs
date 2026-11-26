/**
 * An uncaught page error, reduced to what may leave the runner in a public artifact: the error's
 * name and the first stack frame served from the dashboard's own origin, as function name, bundle
 * file name, line and column. The message, URLs, hosts and every other frame stay out.
 */
const name = /^[A-Z][A-Za-z0-9]{0,63}$/;
const fn = /^[A-Za-z_$][\w$.]{0,63}$/;
const file = /^[A-Za-z0-9._-]{1,128}\.m?js$/;
// "    at fn (https://host/path/file.js:1:2)" (V8) or "fn@https://host/path/file.js:1:2" (others).
const frame =
  /^\s*(?:at\s+(?:async\s+)?(?:(\S+)\s+\()?|(\S*)@)(\w+:\/\/[^\s()]+?):(\d{1,9}):(\d{1,9})\)?\s*$/;

/** `origin` is the dashboard's, such as `http://127.0.0.1:4321`; other origins' frames are skipped. */
export function closedPageError(error, origin) {
  const record = {
    name: typeof error?.name === "string" && name.test(error.name) ? error.name : "unknown",
  };
  for (const line of (typeof error?.stack === "string" ? error.stack : "").split("\n")) {
    const match = frame.exec(line);
    if (!match) continue;
    let url;
    try {
      url = new URL(match[3]);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    const base = url.pathname.split("/").at(-1) ?? "";
    if (!file.test(base)) continue;
    const called = match[1] ?? match[2];
    return {
      ...record,
      frame: {
        ...(called && fn.test(called) ? { function: called } : {}),
        file: base,
        line: Number(match[4]),
        column: Number(match[5]),
      },
    };
  }
  return record;
}

/** The same fields, revalidated, for a summary that reads them back from a proof's files. */
export function revalidatedPageErrors(value) {
  if (!Array.isArray(value)) return undefined;
  const count = (n) => Number.isSafeInteger(n) && n > 0 && n <= 1_000_000_000;
  return value.slice(0, 5).map((entry) => {
    const recorded = entry?.frame;
    return {
      name: typeof entry?.name === "string" && name.test(entry.name) ? entry.name : "unknown",
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
