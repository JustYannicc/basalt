// One repository's tag list, read page by page (OCI distribution) and failing closed. Each stop says
// which rule tripped, on which page and after how many entries, and carries a record of closed facts:
// counts, booleans, known names and character classes, never an entry, a cursor value or a URL.
// Cloudflare's registry lists one `sha256:<hex>` entry for every manifest besides the tags; such an
// entry is a digest reference, held to the stage's own digest rule, and never read as a tag.
import { DIGEST, fail, tagPageOf } from "./answers.mjs";
import { linkShape, nextLinksOf, queryPairsOf, shapeOf } from "./link-header.mjs";

export { shapeOf };
/** A registry tag (OCI distribution): no separator, and no leading dot, so never a dot segment. */
export const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;
/** A page size registries answer in pages of 5 still reaches 5,000 entries within the limit. */
export const MAX_TAG_PAGES = 1000;
/** How many entries a page the stage builds itself asks for. */
const TAG_PAGE = 1000;
/** A parameter of the registry's next link the stage will send back: a plain name, a plain value. */
const CURSOR_NAME = /^[A-Za-z_]{1,32}$/u;
const CURSOR_VALUE = /^[A-Za-z0-9._~+/=:-]{1,1024}$/u;
const MAX_CURSOR_PARAMS = 4;
/** OCI's digest grammar, only to record whether a refused entry looked like one. */
const DIGEST_SHAPE = /^[a-z0-9]+(?:[+._-][a-z0-9]+)*:[a-zA-Z0-9=_-]+$/u;

/**
 * The cursor the registry's next link carries, as name and value pairs: the last value of each
 * name in its target's query, so a query the registry appended twice reads as its latest. Undefined
 * when the header has no next link the stage can take apart, several that disagree, a target with
 * a fragment, or a part that does not decode.
 */
function linkCursor(header) {
  const links = nextLinksOf(header);
  // Several next links that disagree name no one cursor: the spec's own `last` decides instead.
  if (new Set(links.map((value) => value.target)).size !== 1) return undefined;
  const [link] = links;
  if (link.target.includes("#")) return undefined;
  const pairs = queryPairsOf(link.target);
  return pairs === undefined ? undefined : [...new Map(pairs)];
}

/**
 * The next page's URL, always the stage's own host and path. It carries the registry's own cursor
 * when its next link holds a few plain cursor values, each re-encoded, so no value can reach the
 * host or the path. Otherwise it is the distribution spec's own paging, `n` and `last` set to the
 * page's last entry: the link is a hint, and no form of it can stop the read by itself. The record
 * says which was used and the header's shape.
 */
export function cursorOf(header, first, lastEntry) {
  const base = `${new URL(first).origin}${new URL(first).pathname}`;
  const shape = linkShape(header, first);
  const params = linkCursor(header);
  const plain =
    params !== undefined &&
    params.length >= 1 &&
    params.length <= MAX_CURSOR_PARAMS &&
    params.every(([name, value]) => CURSOR_NAME.test(name) && CURSOR_VALUE.test(value)) &&
    params.some(([name]) => name !== "n");
  if (plain) {
    const query = params.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("&");
    return { facts: Object.freeze({ cursor: "link", header: shape }), url: `${base}?${query}` };
  }
  // The spec's cursor is an entry this read already accepted: a tag or an exact digest, nothing else.
  if (lastEntry === undefined || !(TAG.test(lastEntry) || DIGEST.test(lastEntry)))
    return { facts: Object.freeze({ cursor: "none", header: shape }) };
  return {
    facts: Object.freeze({ cursor: "spec", header: shape }),
    url: `${base}?n=${TAG_PAGE}&last=${encodeURIComponent(lastEntry)}`,
  };
}

/** Which of the stage's own failures a later page met; its message is the stage's, never remote. */
const causeOf = (error) => {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("could not be sent")) return "unsent";
  if (message.includes("answered a redirect")) return "redirect";
  if (message.includes("without its tags")) return "no-tags";
  if (message.includes("time budget is spent")) return "out-of-time";
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
        // A long read keeps its first and last pages' details, so a record stays small.
        pages: Object.freeze(
          (pages.length > 40 ? [...pages.slice(0, 20), ...pages.slice(-20)] : pages).map((page) =>
            Object.freeze(page),
          ),
        ),
        pagesOmitted: Math.max(0, pages.length - 40),
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
      const cause = causeOf(error);
      throw stop(
        "later-page-failed",
        cause === "out-of-time"
          ? "A registry tag list was not read to its end: the run's time budget is spent"
          : "A registry tag list's later page could not be read",
        { cause },
      );
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
    const cursor = cursorOf(answer.link, first, found.at(-1));
    pages.at(-1).link = cursor.facts;
    // An empty page ends the list: the distribution spec has a registry fill every page unless
    // fewer entries remain. Only a link that offers a fresh cursor the stage could follow, one that
    // is neither empty (`n` is a page size, not a cursor) nor the query just sent, could mean more:
    // that stops the read instead of ending it.
    if (!found.length) {
      // A link cursor is plain by then: a name besides `n`, and no empty value.
      const fresh = cursor.facts.cursor === "link" && cursor.url !== url;
      if (!fresh) return Object.freeze(tags);
      throw stop("next-after-empty", "A registry tag list offered another page after an empty one");
    }
    if (cursor.url === undefined)
      throw stop("no-cursor", "A registry tag list's last entry cannot carry the next page", {
        entry: Object.freeze({
          ...shapeOf(found.at(-1)),
          digestShaped: DIGEST_SHAPE.test(found.at(-1)),
        }),
      });
    url = cursor.url;
  }
  throw stop("page-limit", `A registry tag list exceeded its page limit of ${MAX_TAG_PAGES}`);
}
