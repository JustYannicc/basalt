/**
 * An in-memory Cloudflare account for the scratch stage's tests: the API rows the inventory reads,
 * the registry's catalog, tags and manifests, and knobs that fail requests the ways a real account
 * can (a refusal, a garbled body, a runtime error that quotes the request URL).
 */
const digest = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;

export interface FakeOptions {
  readonly accountId?: string;
  readonly refuseImageDelete?: boolean;
  /** Requests whose URL matches answer with this HTTP status and an error body. */
  readonly refuse?: { readonly match: RegExp; readonly status: number };
  /** Requests whose URL matches answer 200 with a body that is not JSON. */
  readonly garble?: RegExp;
  /** Requests whose URL matches throw the way a failed connection does, URL in the message. */
  readonly reset?: RegExp;
}

export function fakeCloudflare(options: FakeOptions = {}) {
  const accountId = options.accountId ?? "acct";
  const repositories = new Map<string, Map<string, string>>([
    [`${accountId}/basalt-route-scratch-1-route-gateway`, new Map([["build1", digest(1)]])],
    // Another stage's image, and one that only shares the stage's prefix: neither is the stage's.
    [
      `${accountId}/basalt-rehearsal-pool-test-rehearsal-1-abcdefghijklmnop`,
      new Map([["v1", digest(2)]]),
    ],
    [`${accountId}/basalt-route-scratch-1-route-gateway-other`, new Map([["v1", digest(3)]])],
  ]);
  const applications = [{ id: "app-1", name: "basalt-route-scratch-1-route-gateway" }];
  const scripts = [{ id: "basalt-route-scratch-1-pool" }];
  const namespaces = [{ id: "ns-1", name: "RouteGateway", script: "basalt-route-scratch-1-pool" }];
  const credentials: Array<{ permissions: string[]; expiration_minutes: number }> = [];
  const deletes: string[] = [];
  const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init);
  const listed = (rows: unknown[]) =>
    json({ success: true, result: rows, result_info: { total_pages: 1 } });

  const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    if (options.reset?.test(url.href)) throw new TypeError(`fetch failed: ${method} ${url.href}`);
    if (options.refuse?.match.test(url.href))
      return json(
        { success: false, errors: [{ code: 7003, message: `no route for ${url.href}` }] },
        { status: options.refuse.status },
      );
    if (options.garble?.test(url.href)) return new Response(`<html>${url.href}</html>`);
    if (url.hostname === "api.cloudflare.com") {
      const path = url.pathname.replace(`/client/v4/accounts/${accountId}/`, "");
      if (path === "containers/registries/registry.cloudflare.com/credentials") {
        credentials.push(JSON.parse(String(init.body)));
        return json({ success: true, result: { username: "u", password: "p" } });
      }
      if (method === "GET" && path === "containers/applications") return listed(applications);
      if (method === "GET" && path === "workers/scripts") return listed(scripts);
      if (method === "GET" && path === "workers/durable_objects/namespaces")
        return listed(namespaces);
      if (method === "GET" && path === "workers/subdomain")
        return json({ success: true, result: { subdomain: "scratch-sub" } });
      if (method === "DELETE") {
        deletes.push(path);
        if (path === "containers/applications/app-1") applications.splice(0);
        if (path.startsWith("workers/scripts/")) scripts.splice(0);
        if (path === "workers/durable_objects/namespaces/ns-1") namespaces.splice(0);
        return json({ success: true, result: null });
      }
    }
    if (url.hostname === "registry.cloudflare.com") {
      if (new Headers(init.headers).get("Authorization") !== `Basic ${btoa("u:p")}`)
        return new Response(null, { status: 401 });
      const path = decodeURIComponent(url.pathname.replace("/v2/", ""));
      if (path === "_catalog") return json({ repositories: [...repositories.keys()] });
      const match = /^(.+)\/(tags\/list|manifests\/(.+))$/u.exec(path);
      const tags = match && repositories.get(match[1]!);
      if (!tags) return new Response(null, { status: 404 });
      if (match![2] === "tags/list") return json({ tags: [...tags.keys()] });
      const reference = match![3]!;
      const found = [...tags.entries()].find(([tag, at]) => tag === reference || at === reference);
      if (!found) return new Response(null, { status: 404 });
      if (method === "DELETE") {
        deletes.push(`registry:${match![1]}`);
        if (options.refuseImageDelete) return new Response(null, { status: 500 });
        tags.delete(found[0]);
        return new Response(null, { status: 202 });
      }
      return json({}, { headers: { "docker-content-digest": found[1] } });
    }
    throw new Error(`unexpected request ${method} ${url.href}`);
  }) as typeof fetch;

  return {
    account: { accountId, token: "fake-token", fetch: fetcher },
    repositories,
    applications,
    scripts,
    credentials,
    deletes,
  };
}
