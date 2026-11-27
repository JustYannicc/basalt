// A registry's Link header, read as web linking (RFC 8288) allows it to be written: one or several
// link-values separated by commas, each a target in angle brackets followed by parameters, where a
// parameter's value is a token or a quoted string and `rel` holds one or more relation types in any
// case. The form without angle brackets, a bare target followed by its parameters, is read too: a
// registry was recorded sending it. Nothing here sends a request or decides where one goes; the
// stage takes at most a cursor from a target (tag-pages.mjs), never its host or path.

/** Character classes a shape may name. */
const CLASSES = [
  ["upper", /[A-Z]/u],
  ["lower", /[a-z]/u],
  ["digit", /[0-9]/u],
  ["dot", /\./u],
  ["dash", /-/u],
  ["underscore", /_/u],
  ["colon", /:/u],
  ["slash", /\//u],
  ["plus", /\+/u],
  ["equals", /=/u],
  ["tilde", /~/u],
  ["percent", /%/u],
  ["space", /\s/u],
  ["other", /[^A-Za-z0-9._:/+=~%\s-]/u],
];

/** What a string is made of, never what it says: its length, its classes and its first one. */
export const shapeOf = (text) =>
  Object.freeze({
    length: text.length,
    classes: CLASSES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name),
    first: CLASSES.find(([, pattern]) => pattern.test(text.charAt(0)))?.[0] ?? "none",
  });

/** Query parameter names a shape may name; any other is `other`. */
const KNOWN_PARAMS = new Set(["n", "last", "cursor", "page", "next", "marker", "token"]);

/** Splits `text` at `separator` where it is outside angle brackets and quoted strings. */
function splitOutside(text, separator) {
  const parts = [];
  let current = "";
  let angle = false;
  let quote = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === "\\" && index + 1 < text.length) {
        current += char + text[++index];
        continue;
      }
      if (char === '"') quote = false;
    } else if (angle) {
      if (char === ">") angle = false;
    } else if (char === '"') quote = true;
    else if (char === "<") angle = true;
    else if (char === separator) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** A parameter's value: a quoted string unquoted, or a token as written. */
const unquote = (value) =>
  value.startsWith('"') && value.endsWith('"') && value.length >= 2
    ? value.slice(1, -1).replace(/\\(.)/gu, "$1")
    : value;

/**
 * Every link-value of a header: its target as written, whether it was in angle brackets, its
 * relation types (lower case) and whether `rel` was quoted.
 */
export function linkValues(header) {
  const values = [];
  for (const raw of splitOutside(header, ",")) {
    const part = raw.trim();
    if (!part) continue;
    let target;
    let rest;
    const bracketed = part.startsWith("<");
    if (bracketed) {
      const close = part.indexOf(">");
      if (close < 0) continue;
      target = part.slice(1, close).trim();
      rest = part.slice(close + 1);
    } else {
      const at = part.indexOf(";");
      target = (at < 0 ? part : part.slice(0, at)).trim();
      rest = at < 0 ? "" : part.slice(at);
    }
    let rel = [];
    let relQuoted;
    for (const param of splitOutside(rest, ";").slice(1)) {
      const at = param.indexOf("=");
      const name = (at < 0 ? param : param.slice(0, at)).trim().toLowerCase();
      if (name !== "rel" || relQuoted !== undefined) continue;
      const value = at < 0 ? "" : param.slice(at + 1).trim();
      relQuoted = value.startsWith('"');
      rel = unquote(value).toLowerCase().split(/\s+/u).filter(Boolean);
    }
    values.push(Object.freeze({ target, bracketed, rel: Object.freeze(rel), relQuoted }));
  }
  return values;
}

/** The header's link-value whose relation types include `next`; undefined when it has none. */
export const nextLinkOf = (header) =>
  linkValues(header).find((value) => value.rel.includes("next"));

/** Whether the header offers a next page at all, even in a form the reader cannot take apart. */
export const offersNextIn = (header) =>
  nextLinkOf(header) !== undefined || /\brel\s*=\s*"?[^";,]*\bnext\b/iu.test(header);

/**
 * A target's query as name and value pairs: everything after its first `?`, split at `&` and at
 * any further `?` (a registry was recorded appending a second query), each part decoded as written,
 * so a `+` stays a `+`. Undefined when a part does not decode.
 */
export function queryPairsOf(target) {
  const start = target.indexOf("?");
  if (start < 0) return [];
  const hash = target.indexOf("#", start);
  const query = target.slice(start + 1, hash < 0 ? undefined : hash);
  const pairs = [];
  for (const part of query.split(/[&?]/u)) {
    if (!part) continue;
    const at = part.indexOf("=");
    try {
      pairs.push(
        at < 0
          ? [decodeURIComponent(part), ""]
          : [decodeURIComponent(part.slice(0, at)), decodeURIComponent(part.slice(at + 1))],
      );
    } catch {
      return undefined;
    }
  }
  return pairs;
}

/**
 * The shape of a whole header, never its text: its length, how many link-values it holds, and for
 * each (up to four) whether it was bracketed, had a scheme or a leading slash, how many `?` and
 * whether a `#` it held, whether it pointed at the stage's own host and path, its relation, and its
 * query keys (known names or `other`) with each value's shape.
 */
export function linkShape(header, first) {
  const base = new URL(first);
  const values = linkValues(header);
  return Object.freeze({
    length: header.length,
    values: values.length,
    links: Object.freeze(
      values.slice(0, 4).map((value) => {
        let parsed;
        try {
          parsed = new URL(value.target, base);
        } catch {
          parsed = undefined;
        }
        const pairs = queryPairsOf(value.target);
        return Object.freeze({
          bracketed: value.bracketed,
          scheme: /^[a-z][a-z0-9+.-]*:/iu.test(value.target),
          leadingSlash: value.target.startsWith("/"),
          questionMarks: value.target.split("?").length - 1,
          fragment: value.target.includes("#"),
          host: parsed === undefined ? "unparsed" : parsed.host === base.host ? "same" : "other",
          path:
            parsed === undefined
              ? "unparsed"
              : parsed.pathname === base.pathname
                ? "same"
                : "other",
          rel: value.rel.length > 0,
          relQuoted: value.relQuoted ?? false,
          next: value.rel.includes("next"),
          decodes: pairs !== undefined,
          params: Object.freeze(
            (pairs ?? []).slice(0, 8).map(([name, text]) =>
              Object.freeze({
                name: KNOWN_PARAMS.has(name) ? name : "other",
                value: shapeOf(text),
              }),
            ),
          ),
        });
      }),
    ),
  });
}
