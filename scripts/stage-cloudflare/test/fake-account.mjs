// An account that holds a stage's resources beside production's and answers the stage API with
// the recorded shapes. Deletes remove what they name, so a read-back after a teardown sees them gone.
import {
  catalog,
  envelope,
  imageIndex,
  listPage,
  registryCredentials,
  settings,
  subdomain,
  tagList,
} from "./cloudflare-shapes.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const PLATFORM = `sha256:${"b".repeat(64)}`;
// Answers are built with inits that inherit nothing, so a test that sets fields on Object.prototype
// changes only what the stage module reads, never what this account answers.
const init = (fields) => Object.assign(Object.create(null), fields);
const json = (body, fields = {}) => Response.json(body, init(fields));
const COLLECTIONS = {
  "containers/applications": "applications",
  "workers/durable_objects/namespaces": "namespaces",
  "workers/scripts": "scripts",
  "hyperdrive/configs": "drives",
  mtls_certificates: "certificates",
};

/** How fetch treats a redirect answer: the method it re-sends with, as the Fetch standard says. */
const followedMethod = (status, method) =>
  status === 303 || ((status === 301 || status === 302) && method === "POST") ? "GET" : method;

/**
 * `live` holds the rows of each kind, `bindings` each Worker's plain-text settings, `tags` each
 * registry repository's tags. `redirects` maps `"<METHOD> <url>"` to the `{ status, location }` the
 * account answers that request with instead; the fetcher then treats the answer as fetch does for
 * the request's `redirect` mode: it re-sends to the location on `follow` (fetch's default), rejects
 * on `error` and returns the answer on `manual`. `calls` lists every method, path, URL, redirect
 * mode and body as sent, for assertions only.
 */
export function fakeAccount({
  accountId = "acct",
  live: rows = {},
  bindings = {},
  tags = {},
  redirects = {},
  workersSubdomain = "acct-sub",
  // The registry's own page size for a tag list: a page holds at most this many tags, whatever `n`.
  tagPageSize = Infinity,
  // How the registry pages a tag list: OCI's `last`, or its own opaque `cursor` that ignores `last`.
  tagCursor = "last",
  /**
   * A registry that answers as Cloudflare's did on 27-11-2026: its list names a `sha256:` entry for
   * every manifest besides the tags, `pageSize` entries a page whatever `n` asks, a next link of
   * `n=1000&last=<the page's last entry>`, digest entries first (`order: "lexical"` sorts all), and,
   * with `emptyEnd`, a last page that is empty and still links on; `linkForm` picks how the link is
   * written (see below). `artifacts` are manifests the
   * registry made itself: `{ digest, type, refuse?: { status, code? }, read?: status }`. `refuse`
   * maps a digest to the refusal its delete answers. `ghosts` are digest entries the list names
   * with no manifest behind them (with `own: false`, the tags are too). `collectAfter: n` keeps an
   * accepted delete's manifest listed and readable until n more first pages of the list are read.
   * `keepsTagged` accepts a digest delete of a manifest a tag still names and does nothing, as the
   * registry did on 28-11-2026; a tag's own delete removes the tag. `refuseTag` maps a tag to the
   * refusal its delete answers. `keepsIndexed` also keeps a manifest an index it holds names, and
   * `childFirst` lists the digest entries in reverse, a platform before its index.
   */
  cloudflare,
} = {}) {
  const live = {
    applications: [],
    namespaces: [],
    scripts: [],
    drives: [],
    certificates: [],
    ...rows,
    tags: { ...tags },
    // Cloudflare mode: each repository's manifests by digest, as its list names them.
    manifests: Object.fromEntries(
      Object.keys(tags).map((name) => [
        name,
        new Map(
          cloudflare
            ? [
                ...(cloudflare.own === false ? [] : [[DIGEST, { body: imageIndex([PLATFORM]) }]]),
                ...(cloudflare.own === false
                  ? []
                  : [
                      [
                        PLATFORM,
                        {
                          body: {
                            schemaVersion: 2,
                            mediaType: "application/vnd.oci.image.manifest.v1+json",
                            config: { mediaType: "application/vnd.oci.image.config.v1+json" },
                          },
                        },
                      ],
                    ]),
                ...(cloudflare.artifacts ?? []).map((artifact) => [
                  artifact.digest,
                  {
                    body: artifact.body ?? {
                      schemaVersion: 2,
                      mediaType: "application/vnd.oci.image.manifest.v1+json",
                      ...(artifact.type === undefined ? {} : { artifactType: artifact.type }),
                      config: { mediaType: "application/vnd.oci.empty.v1+json" },
                    },
                    refuse: artifact.refuse,
                    read: artifact.read,
                    acceptOnly: artifact.acceptOnly,
                  },
                ]),
              ]
            : [],
        ),
      ]),
    ),
  };
  const calls = [];
  // Accepted deletes the registry has not collected yet, and how many first pages it has served.
  const pending = [];
  let firstPages = 0;
  const fetcher = async (url, options = {}) => {
    const { hostname, pathname, searchParams } = new URL(url);
    const method = options.method ?? "GET";
    const mode = options.redirect ?? "follow";
    const call = { method, host: hostname, path: pathname, url: String(url), redirect: mode };
    if (options.headers?.Authorization) call.authorization = options.headers.Authorization;
    if (typeof options.body === "string") call.body = options.body;
    calls.push(call);
    const redirect = redirects[`${method} ${url}`];
    if (redirect) {
      if (mode === "error") throw new TypeError("fetch failed");
      if (mode === "manual")
        return new Response(
          null,
          init({ status: redirect.status, headers: { location: redirect.location } }),
        );
      return fetcher(redirect.location, {
        ...options,
        method: followedMethod(redirect.status, method),
      });
    }
    if (hostname === "registry.cloudflare.com")
      return registry(method, pathname, searchParams, options.headers?.Accept ?? "");
    const prefix = `/client/v4/accounts/${accountId}/`;
    if (!pathname.startsWith(prefix)) return json({}, { status: 404 });
    const rest = pathname.slice(prefix.length);
    if (rest === "workers/subdomain") return json(subdomain(workersSubdomain));
    if (rest === "containers/registries/registry.cloudflare.com/credentials") {
      // A credential names what it was minted for, so a test can tell which one a request carried.
      const asked = typeof options.body === "string" ? JSON.parse(options.body).permissions : [];
      return json({
        ...registryCredentials(),
        result: { username: `<${asked.join("+")}>`, password: "<secret>" },
      });
    }
    const settingsOf = /^workers\/scripts\/([^/]+)\/settings$/u.exec(rest);
    if (settingsOf) {
      const name = decodeURIComponent(settingsOf[1]);
      return live.scripts.some((row) => row.id === name)
        ? json(settings(bindings[name]))
        : json({}, { status: 404 });
    }
    const [collection, kind] =
      Object.entries(COLLECTIONS).find(([path]) => rest === path || rest.startsWith(`${path}/`)) ??
      [];
    if (!kind) return json({}, { status: 404 });
    if (rest === collection) {
      const page = Number(searchParams.get("page") ?? 1);
      return json(listPage(live[kind].slice((page - 1) * 100, page * 100)));
    }
    const id = decodeURIComponent(rest.slice(collection.length + 1));
    const found = live[kind].find((row) => row.id === id);
    if (method === "DELETE") {
      if (!found) return json({}, { status: 404 });
      live[kind] = live[kind].filter((row) => row !== found);
      // Deleting a Worker deletes the Durable Object namespaces it owns.
      if (kind === "scripts") live.namespaces = live.namespaces.filter((row) => row.script !== id);
      return json(envelope(null));
    }
    return found ? json(envelope(found)) : json({}, { status: 404 });
  };

  function registry(method, pathname, searchParams, accept) {
    if (pathname === "/v2/_catalog") return json(catalog(Object.keys(live.tags)));
    const listing = /^\/v2\/(.+)\/tags\/list$/u.exec(pathname);
    if (listing && cloudflare) {
      const name = decodeURIComponent(listing[1]);
      if (!(name in live.tags)) return json({}, { status: 404 });
      const last = searchParams.get("last");
      if (last === null || last === "") {
        firstPages += 1;
        for (const due of pending.filter((row) => row.name === name && row.at <= firstPages)) {
          pending.splice(pending.indexOf(due), 1);
          live.manifests[name].delete(due.digest);
          untag(name, due.digest);
        }
      }
      const digests = [...live.manifests[name].keys(), ...(cloudflare.ghosts ?? [])].sort();
      // A real registry lists its entries in no order of its own: a platform before its index.
      if (cloudflare.childFirst) digests.reverse();
      const named = [...live.tags[name]].sort();
      const entries =
        cloudflare.order === "lexical" ? [...digests, ...named].sort() : [...digests, ...named];
      const after =
        last === null || last === "" ? entries : entries.slice(entries.indexOf(last) + 1);
      const page = after.slice(0, cloudflare.pageSize ?? 5);
      const more = after.length > page.length;
      const cursor = encodeURIComponent(page.at(-1) ?? "");
      // `linkForm`: "bracketed" (RFC 8288, relative); "recorded", the form recorded for this
      // registry: the full request URL with no brackets, a second query appended, `rel` unquoted;
      // "unknown", a header that offers a next page in a form no reader can take apart.
      const forms = {
        bracketed: () => `</v2/${listing[1]}/tags/list?n=1000&last=${cursor}>; rel="next"`,
        recorded: () =>
          `https://registry.cloudflare.com/v2/${listing[1]}/tags/list?${searchParams}?n=1000&last=${cursor}; rel=next`,
        unknown: () => `{next: ${cursor}}; rel=next ~`,
      };
      const link =
        more || (cloudflare.emptyEnd && last !== "")
          ? forms[cloudflare.linkForm ?? "bracketed"]()
          : undefined;
      return json(tagList(name, page), { headers: link ? { link } : {} });
    }
    if (listing) {
      const name = decodeURIComponent(listing[1]);
      if (!(name in live.tags)) return json({}, { status: 404 });
      // OCI distribution paging: tags in lexical order, up to `n` after `last`, and a `next` link
      // while more remain.
      const sorted = [...live.tags[name]].sort();
      const size = Math.min(Number(searchParams.get("n") ?? Infinity), tagPageSize);
      const opaque = tagCursor === "opaque";
      const last = searchParams.get("last");
      const offset = opaque
        ? Number(Buffer.from(searchParams.get("cursor") ?? "MA", "base64url").toString())
        : 0;
      const after = opaque
        ? sorted.slice(offset)
        : last === null
          ? sorted
          : sorted.filter((tag) => tag > last);
      const page = after.slice(0, size);
      const more = after.length > page.length;
      const query = opaque
        ? `cursor=${Buffer.from(String(offset + page.length)).toString("base64url")}`
        : `n=${page.length}&last=${encodeURIComponent(page.at(-1))}`;
      return json(tagList(name, sorted.length ? page : null), {
        headers: more ? { link: `</v2/${listing[1]}/tags/list?${query}>; rel="next"` } : {},
      });
    }
    const manifest = /^\/v2\/(.+)\/manifests\/(.+)$/u.exec(pathname);
    if (!manifest) return json({}, { status: 404 });
    const name = decodeURIComponent(manifest[1]);
    const reference = decodeURIComponent(manifest[2]);
    if (cloudflare) return cloudflareManifest(method, name, reference, accept);
    if (!live.tags[name]?.length) return json({}, { status: 404 });
    if (method === "DELETE") {
      // The index goes first; once it is gone no tag reaches the platform manifest either.
      if (reference === DIGEST) live.tags[name] = [];
      return new Response(null, init({ status: 202 }));
    }
    const index = reference === PLATFORM ? { schemaVersion: 2 } : imageIndex([PLATFORM]);
    return json(index, {
      headers: { "docker-content-digest": reference === PLATFORM ? PLATFORM : DIGEST },
    });
  }

  /** Removes the tags of a Cloudflare-mode repository that name `digest`, as its delete does. */
  function untag(name, digest) {
    live.tags[name] = live.tags[name].filter(
      (tag) => (cloudflare.tagged?.[tag] ?? DIGEST) !== digest,
    );
  }

  /** A manifest of the Cloudflare-mode registry: deleting a digest removes the tags naming it. */
  function cloudflareManifest(method, name, reference, accept) {
    const manifests = live.manifests[name];
    if (!manifests) return json({}, { status: 404 });
    // A tag names the stage's own index unless `tagged` points it at another manifest.
    const digest = live.tags[name]?.includes(reference)
      ? (cloudflare.tagged?.[reference] ?? DIGEST)
      : reference;
    const found = manifests.get(digest);
    if (!found) return json({}, { status: 404 });
    if (method === "DELETE") {
      const byTag = digest !== reference;
      const refusal =
        (byTag ? cloudflare.refuseTag?.[reference] : undefined) ??
        found.refuse ??
        cloudflare.refuse?.[digest];
      // As destroy 46081919333 saw it: a digest delete of a manifest a tag still names is accepted
      // and changes nothing; a tag's own delete removes that tag.
      if (cloudflare.keepsTagged && !refusal) {
        if (byTag) {
          live.tags[name] = live.tags[name].filter((tag) => tag !== reference);
          return new Response(null, init({ status: 202 }));
        }
        const named = live.tags[name].some(
          (tag) => (cloudflare.tagged?.[tag] ?? DIGEST) === digest,
        );
        if (named) return new Response(null, init({ status: 202 }));
        // And one that keeps a manifest an index it still holds names.
        const indexed =
          cloudflare.keepsIndexed &&
          [...manifests.values()].some((other) =>
            other.body?.manifests?.some((entry) => entry.digest === digest),
          );
        if (indexed) return new Response(null, init({ status: 202 }));
      }
      // A delete the transport itself fails, as a dropped connection does.
      if (refusal?.throws) throw new TypeError("fetch failed");
      // Accepted, yet still listed after: the registry kept it without saying so.
      if (refusal?.stays) return new Response(null, init({ status: 202 }));
      // Refused, yet collected by the registry before the read after.
      if (refusal?.removes) manifests.delete(digest);
      if (refusal)
        return json(
          { errors: refusal.code ? [{ code: refusal.code, message: "refused" }] : [] },
          { status: refusal.status },
        );
      if (cloudflare.collectAfter !== undefined) {
        if (!pending.some((row) => row.name === name && row.digest === digest))
          pending.push({ name, digest, at: firstPages + cloudflare.collectAfter });
        return new Response(null, init({ status: 202 }));
      }
      manifests.delete(digest);
      untag(name, digest);
      return new Response(null, init({ status: 202 }));
    }
    if (found.read) return json({}, { status: found.read });
    // A registry that serves an artifact only to a read that accepts its own type.
    const accepted = accept.split(/,\s*/u);
    if (found.acceptOnly && !accepted.includes("*/*") && !accepted.includes(found.acceptOnly))
      return json({}, { status: 406 });
    return json(found.body, { headers: { "docker-content-digest": digest } });
  }

  return { live, calls, fetcher };
}
