// One repository's tag list, read page by page (OCI distribution) and failing closed. Each stop says
// which rule tripped, on which page and after how many tags, and carries a record of closed facts:
// counts, booleans, known names and character classes, never a tag, a cursor value or a URL.
import { fail, tagPageOf } from "./answers.mjs";

/** A registry tag (OCI distribution): no separator, and no leading dot, so never a dot segment. */
export const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;
export const MAX_TAG_PAGES = 100;
/** A parameter of the registry's next link the stage will send back: a plain name, a plain value. */
const CURSOR_NAME = /^[A-Za-z_]{1,32}$/u;
const CURSOR_VALUE = /^[A-Za-z0-9._~+/=:-]{1,1024}$/u;
const MAX_CURSOR_PARAMS = 4;
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
  ["percent", /%/u],
  ["space", /\s/u],
  ["other", /[^A-Za-z0-9._:/%\s-]/u],
];

/** What a string is made of, never what it says: its length, its classes and its first one. */
export const shapeOf = (text) =>
  Object.freeze({
    length: text.length,
    classes: CLASSES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name),
    first: CLASSES.find(([, pattern]) => pattern.test(text.charAt(0)))?.[0] ?? "none",
  });

/**
 * The next page's URL: the stage's own host and path, with only the parameters of the registry's
 * next link, each re-encoded, so no cursor value can reach the host or the path. No URL when the
 * link has no target, does not parse, or carries anything but a few plain cursor values.
 */
export function cursorOf(target, first) {
  if (target === undefined) return { facts: Object.freeze({ target: "none" }) };
  const base = new URL(first);
  let parsed;
  try {
    parsed = new URL(target, base);
  } catch {
    return { facts: Object.freeze({ target: "present", parses: false }) };
  }
  const params = [...parsed.searchParams];
  const facts = Object.freeze({
    target: "present",
    parses: true,
    host: parsed.host === base.host ? "same" : "other",
    path: parsed.pathname === base.pathname ? "same" : "other",
    paramCount: params.length,
    params: params
      .slice(0, 8)
      .map(([name, value]) =>
        Object.freeze({ name: KNOWN_PARAMS.has(name) ? name : "other", value: shapeOf(value) }),
      ),
  });
  const names = new Set(params.map(([name]) => name));
  const plain =
    params.length >= 1 &&
    params.length <= MAX_CURSOR_PARAMS &&
    names.size === params.length &&
    params.every(([name, value]) => CURSOR_NAME.test(name) && CURSOR_VALUE.test(value));
  if (!plain) return { facts };
  const next = new URL(`${base.origin}${base.pathname}`);
  for (const [name, value] of params) next.searchParams.append(name, value);
  return { facts, url: next.href };
}

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
    const answer = tagPageOf(await fetchPage(url));
    if (answer.gone) {
      if (page === 1) return Object.freeze([]);
      pages.push({ status: 404, tags: 0, next: false });
      throw stop("gone-on-later-page", "A registry tag list's later page answered 404");
    }
    const found = answer.tags;
    pages.push({ status: 200, tags: found.length, next: answer.next });
    const unnamed = found.find((tag) => !TAG.test(tag));
    if (unnamed !== undefined)
      throw stop("cannot-name", "A registry tag list answered a tag it cannot name", {
        tag: shapeOf(unnamed),
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
    if (!found.length)
      throw stop("next-after-empty", "A registry tag list offered another page after an empty one");
    const cursor = cursorOf(answer.target, first);
    pages.at(-1).link = cursor.facts;
    if (cursor.url === undefined)
      throw stop("link-not-plain", "A registry tag list's next link is not plain cursor values");
    url = cursor.url;
  }
  throw stop("page-limit", `A registry tag list exceeded its page limit of ${MAX_TAG_PAGES}`);
}
