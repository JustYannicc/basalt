// One repository's tag list, read page by page (OCI distribution) and failing closed. Each stop says
// which rule tripped, on which page and after how many entries, and carries a record of closed facts:
// counts, booleans, known names and character classes, never an entry, a cursor value or a URL.
// Cloudflare's registry lists one `sha256:<hex>` entry for every manifest besides the tags; such an
// entry is a digest reference, held to the stage's own digest rule, and never read as a tag.
import { DIGEST, fail, tagPageOf } from "./answers.mjs";

/** A registry tag (OCI distribution): no separator, and no leading dot, so never a dot segment. */
export const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;
export const MAX_TAG_PAGES = 100;
/** A parameter of the registry's next link the stage will send back: a plain name, a plain value. */
const CURSOR_NAME = /^[A-Za-z_]{1,32}$/u;
const CURSOR_VALUE = /^[A-Za-z0-9._~+/=:-]{1,1024}$/u;
const MAX_CURSOR_PARAMS = 4;
/** OCI's digest grammar, only to record whether a refused entry looked like one. */
const DIGEST_SHAPE = /^[a-z0-9]+(?:[+._-][a-z0-9]+)*:[a-zA-Z0-9=_-]+$/u;
/** Parameter names a record may name; any other is recorded as `other`. */
const KNOWN_PARAMS = new Set(["n", "last", "cursor", "page", "next", "marker", "token"]);
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

/** A link's query as name and value pairs, decoded as written: a `+` stays a `+`. */
function queryPairs(search) {
  const pairs = [];
  for (const part of search.slice(1).split("&")) {
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
 * The next page's URL: the stage's own host and path, with only the parameters of the registry's
 * next link, each re-encoded, so no cursor value can reach the host or the path. No URL when the
 * link has no target the stage can read, does not parse, has a fragment, or carries anything but a
 * few plain cursor values.
 */
export function cursorOf(target, first) {
  if (target === undefined) return { facts: Object.freeze({ target: "unreadable" }) };
  const base = new URL(first);
  let parsed;
  try {
    parsed = new URL(target, base);
  } catch {
    return { facts: Object.freeze({ target: "present", parses: false }) };
  }
  const pairs = queryPairs(parsed.search);
  const params = pairs ?? [];
  const plainParam = ([name, value]) => CURSOR_NAME.test(name) && CURSOR_VALUE.test(value);
  const facts = Object.freeze({
    target: "present",
    parses: true,
    host: parsed.host === base.host ? "same" : "other",
    path: parsed.pathname === base.pathname ? "same" : "other",
    fragment: parsed.hash !== "",
    decodes: pairs !== undefined,
    paramCount: params.length,
    params: params.slice(0, 8).map(([name, value]) =>
      Object.freeze({
        name: KNOWN_PARAMS.has(name) ? name : "other",
        plainName: CURSOR_NAME.test(name),
        plainValue: CURSOR_VALUE.test(value),
        value: shapeOf(value),
      }),
    ),
  });
  const plain =
    pairs !== undefined &&
    parsed.hash === "" &&
    params.length >= 1 &&
    params.length <= MAX_CURSOR_PARAMS &&
    new Set(params.map(([name]) => name)).size === params.length &&
    params.every(plainParam);
  if (!plain) return { facts };
  const query = params.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("&");
  return { facts, url: `${base.origin}${base.pathname}?${query}` };
}

/** Which of the stage's own failures a later page met; its message is the stage's, never remote. */
const causeOf = (error) => {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("could not be sent")) return "unsent";
  if (message.includes("answered a redirect")) return "redirect";
  if (message.includes("without its tags")) return "no-tags";
  return "other";
};

/**
 * Every tag of one repository, from `first`, the URL the stage built from its own repository.
 * `fetchPage(url)` returns one answer. A repository that is gone on the first page holds no tags; on
 * a later page that is a stop, never the end of the list.
 */
export async function readTagPages(first, fetchPage) {
  const tags = [];
  const seen = new Set();
  const pages = [];
  let firstPage;
  const stop = (rule, message, facts = {}) => {
    const error = fail(
      `${message} (page ${pages.length}, after ${tags.length} tag${tags.length === 1 ? "" : "s"})`,
    );
    error.record = Object.freeze({
      tagRead: Object.freeze({
        rule,
        pagesRead: pages.length,
        tagsAccepted: tags.length,
        pages: Object.freeze(pages.map((page) => Object.freeze(page))),
        ...facts,
      }),
    });
    return error;
  };
  let url = first;
  for (let page = 1; page <= MAX_TAG_PAGES; page++) {
    let answer;
    try {
      const raw = await fetchPage(url);
      // A later page that fails says so with its page; it never ends the list as if complete.
      if (page > 1 && !raw.ok && raw.status !== 404) {
        pages.push({ status: raw.status, tags: 0, next: false });
        throw stop(
          "later-page-failed",
          `A registry tag list's later page answered HTTP ${raw.status}`,
        );
      }
      answer = tagPageOf(raw);
      if (page > 1 && answer.missing) throw fail("A registry tag list answered without its tags");
    } catch (error) {
      if (page === 1 || Object.hasOwn(error, "record")) throw error;
      pages.push({ status: "unread", tags: 0, next: false });
      throw stop("later-page-failed", "A registry tag list's later page could not be read", {
        cause: causeOf(error),
      });
    }
    if (answer.gone) {
      if (page === 1) return Object.freeze([]);
      pages.push({ status: 404, tags: 0, next: false });
      throw stop("gone-on-later-page", "A registry tag list's later page answered 404");
    }
    const found = answer.tags;
    pages.push({ status: 200, tags: found.length, next: answer.next });
    const unnamed = found.find((entry) => !TAG.test(entry) && !DIGEST.test(entry));
    if (unnamed !== undefined)
      throw stop("cannot-name", "A registry tag list answered a tag it cannot name", {
        tag: Object.freeze({ ...shapeOf(unnamed), digestShaped: DIGEST_SHAPE.test(unnamed) }),
      });
    const onPage = new Set(found);
    const repeats = found.filter((tag) => seen.has(tag)).length;
    if (onPage.size !== found.length || repeats)
      throw stop("already-listed", "A registry tag list answered a tag it had already listed", {
        where: repeats ? "earlier-page" : "same-page",
        repeats: repeats || found.length - onPage.size,
        sameAsFirstPage:
          page > 1 &&
          found.length === firstPage.length &&
          found.every((tag, index) => tag === firstPage[index]),
      });
    tags.push(...found);
    for (const tag of found) seen.add(tag);
    firstPage ??= found;
    if (!answer.next) return Object.freeze(tags);
    const cursor = cursorOf(answer.target, first);
    pages.at(-1).link = cursor.facts;
    // Cloudflare's registry ends a list only with an empty page, which still carries a next link
    // with an empty cursor; nothing can follow a page that holds nothing.
    if (!found.length) return Object.freeze(tags);
    if (cursor.url === undefined)
      throw stop("link-not-plain", "A registry tag list's next link is not plain cursor values");
    url = cursor.url;
  }
  throw stop("page-limit", `A registry tag list exceeded its page limit of ${MAX_TAG_PAGES}`);
}
