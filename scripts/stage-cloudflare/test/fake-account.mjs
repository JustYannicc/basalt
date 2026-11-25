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
const COLLECTIONS = {
  "containers/applications": "applications",
  "workers/durable_objects/namespaces": "namespaces",
  "workers/scripts": "scripts",
  "hyperdrive/configs": "drives",
  mtls_certificates: "certificates",
};

/**
 * `live` holds the rows of each kind, `bindings` each Worker's plain-text settings, `tags` each
 * registry repository's tags. `calls` lists every method, path and URL as sent, for assertions only.
 */
export function fakeAccount({
  accountId = "acct",
  live: rows = {},
  bindings = {},
  tags = {},
  workersSubdomain = "acct-sub",
} = {}) {
  const live = {
    applications: [],
    namespaces: [],
    scripts: [],
    drives: [],
    certificates: [],
    ...rows,
    tags: { ...tags },
  };
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const { hostname, pathname, searchParams } = new URL(url);
    const method = init.method ?? "GET";
    const call = { method, host: hostname, path: pathname, url: String(url) };
    calls.push(call);
    if (hostname === "registry.cloudflare.com") return registry(method, pathname);
    const prefix = `/client/v4/accounts/${accountId}/`;
    if (!pathname.startsWith(prefix)) return Response.json({}, { status: 404 });
    const rest = pathname.slice(prefix.length);
    if (rest === "workers/subdomain") return Response.json(subdomain(workersSubdomain));
    if (rest === "containers/registries/registry.cloudflare.com/credentials")
      return Response.json(registryCredentials());
    const settingsOf = /^workers\/scripts\/([^/]+)\/settings$/u.exec(rest);
    if (settingsOf) {
      const name = decodeURIComponent(settingsOf[1]);
      return live.scripts.some((row) => row.id === name)
        ? Response.json(settings(bindings[name]))
        : Response.json({}, { status: 404 });
    }
    const [collection, kind] =
      Object.entries(COLLECTIONS).find(([path]) => rest === path || rest.startsWith(`${path}/`)) ??
      [];
    if (!kind) return Response.json({}, { status: 404 });
    if (rest === collection) {
      const page = Number(searchParams.get("page") ?? 1);
      return Response.json(listPage(live[kind].slice((page - 1) * 100, page * 100)));
    }
    const id = decodeURIComponent(rest.slice(collection.length + 1));
    const found = live[kind].find((row) => row.id === id);
    if (method === "DELETE") {
      if (!found) return Response.json({}, { status: 404 });
      live[kind] = live[kind].filter((row) => row !== found);
      // Deleting a Worker deletes the Durable Object namespaces it owns.
      if (kind === "scripts") live.namespaces = live.namespaces.filter((row) => row.script !== id);
      return Response.json(envelope(null));
    }
    return found ? Response.json(envelope(found)) : Response.json({}, { status: 404 });
  };

  function registry(method, pathname) {
    if (pathname === "/v2/_catalog") return Response.json(catalog(Object.keys(live.tags)));
    const listing = /^\/v2\/(.+)\/tags\/list$/u.exec(pathname);
    if (listing) {
      const name = decodeURIComponent(listing[1]);
      return name in live.tags
        ? Response.json(tagList(name, live.tags[name].length ? live.tags[name] : null))
        : Response.json({}, { status: 404 });
    }
    const manifest = /^\/v2\/(.+)\/manifests\/(.+)$/u.exec(pathname);
    if (!manifest) return Response.json({}, { status: 404 });
    const name = decodeURIComponent(manifest[1]);
    const reference = decodeURIComponent(manifest[2]);
    if (!live.tags[name]?.length) return Response.json({}, { status: 404 });
    if (method === "DELETE") {
      // The index goes first; once it is gone no tag reaches the platform manifest either.
      if (reference === DIGEST) live.tags[name] = [];
      return new Response(null, { status: 202 });
    }
    const index = reference === PLATFORM ? { schemaVersion: 2 } : imageIndex([PLATFORM]);
    return Response.json(index, {
      headers: { "docker-content-digest": reference === PLATFORM ? PLATFORM : DIGEST },
    });
  }

  return { live, calls, fetcher };
}
