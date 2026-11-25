// An account where a stage's resources sit beside production's, other stages' and look-alikes', and
// an oracle that judges every request the fake account received against what that stage may reach.
// The oracle reads the raw URL as sent and decides on its own, without the module's code.
import { application, certificate, hyperdrive, namespace, script } from "./cloudflare-shapes.mjs";
import { fakeAccount } from "./fake-account.mjs";

export const accountId = "acct";
/** Prefixes that share words with a stage's, or continue it, but are not its. */
export const lookAlikes = (prefix) =>
  [
    "basalt-route-scratch",
    "basalt-180-scale-big",
    "basalt-180-scal",
    "basalt-emulated-upstream",
    "basalt-route-scratch-1",
    "basalt-route-scratch-2",
    "basalt-180-scale",
    `${prefix}x`,
  ].filter((other) => other !== prefix && !other.startsWith(`${prefix}-`));
const CLEAN = /^[A-Za-z0-9_-]+$/u;
/** Ids a stage's own rows may carry that no URL may hold. */
export const unaddressableIds = [
  "../prod-app",
  "own%2f..%2fprod-app",
  "own%2e%2e",
  "own%5cprod-app",
  "own?force=true",
  "own#settings",
  "own app",
  "https://api.cloudflare.com/client/v4/accounts/acct/containers/applications/prod-app",
  "/accounts/acct/containers/applications/prod-app",
];

/** The account one stage shares with production, other stages and look-alikes. */
export function sharedAccount(prefix) {
  const others = lookAlikes(prefix);
  return fakeAccount({
    accountId,
    live: {
      applications: [
        application({ id: "own-app", name: `${prefix}-pool` }),
        application({ id: "prod-app", name: "basalt-production-poolcontainer" }),
        ...others.map((other, index) =>
          application({ id: `other-app-${index}`, name: `${other}-pool` }),
        ),
        ...unaddressableIds.map((id, index) => application({ id, name: `${prefix}-odd-${index}` })),
      ],
      scripts: [
        script(`${prefix}-gateway`),
        script("basalt-production-poolworker"),
        ...others.map((other) => script(`${other}-gateway`)),
        script(`${prefix}-gateway/../basalt-production-poolworker`),
      ],
      namespaces: [
        namespace({ id: "own-ns", className: "Mock", script: `${prefix}-gateway` }),
        namespace({ id: "prod-ns", className: "Pool", script: "basalt-production-poolworker" }),
        // A production Worker's namespace whose own name merely carries the prefix.
        namespace({
          id: "prod-lookalike-ns",
          className: "Pool",
          script: "basalt-production-poolworker",
          name: `${prefix}-lookalike`,
        }),
      ],
      drives: [
        hyperdrive({ id: "own-drive", name: `${prefix}-auth` }),
        hyperdrive({ id: "prod-drive", name: "basalt-production" }),
      ],
      certificates: [
        certificate({ id: "own-ca", name: `${prefix}-ca` }),
        certificate({ id: "prod-ca", name: "basalt-production-ca" }),
      ],
    },
    bindings: { [`${prefix}-gateway`]: { DELETE_BY: "1" } },
    tags: {
      [`${accountId}/${prefix}-pool`]: ["h1"],
      [`${accountId}/basalt-poolcontainer-production`]: ["p1"],
      [`other/${prefix}-pool`]: ["x1"],
      [`${accountId}/${prefix}-pool/nested`]: ["n1"],
      ...Object.fromEntries(others.map((other) => [`${accountId}/${other}-pool`, ["o1"]])),
    },
  });
}

// A kind addressed by an opaque id is read back by that id before the stage acts on it: a bare GET
// of one id, which changes nothing and is the only call that may name an id that is not the
// stage's. Every other call to such an id, and any call at all to another kind's, is outside.
const COLLECTIONS = {
  "containers/applications": { kind: "applications", below: ["", "/rollouts"], readBack: true },
  "workers/durable_objects/namespaces": { kind: "namespaces", below: [] },
  "workers/scripts": { kind: "scripts", below: ["", "/settings"] },
  "hyperdrive/configs": { kind: "drives", below: [""], readBack: true },
  mtls_certificates: { kind: "certificates", below: [""], readBack: true },
};
const ownerName = (kind, row) =>
  kind === "namespaces" ? (row.script ?? row.name) : (row.name ?? row.id);

/**
 * What `prefix`'s stage may reach in `fake`, from the rows it holds now: a function of one recorded
 * call that answers why it is outside, or undefined when it is the stage's.
 */
export function stageReach(fake, prefix) {
  const ours = (name) => typeof name === "string" && name.startsWith(`${prefix}-`);
  const ids = Object.fromEntries(
    Object.values(COLLECTIONS).map(({ kind }) => [
      kind,
      new Set(
        fake.live[kind]
          .filter((row) => ours(ownerName(kind, row)) && CLEAN.test(row.id))
          .map((row) => row.id),
      ),
    ]),
  );
  const repositories = new Set(
    Object.keys(fake.live.tags)
      .map((repository) => repository.split("/"))
      .filter(
        ([owner, name, ...rest]) =>
          owner === accountId && !rest.length && ours(name) && CLEAN.test(name),
      )
      .map(([, name]) => name),
  );
  return function outside({ url, method }) {
    const parsed = new URL(url);
    if (parsed.href !== url) return "the URL is not as it was sent once parsed";
    if (/%(?:2f|2e|5c|25|3f|23|20)|\/\/|\\/iu.test(parsed.pathname.slice(1)))
      return "an escaped separator, dot, query or space in the path";
    if (parsed.hash) return "a fragment";
    if (parsed.hostname === "registry.cloudflare.com") {
      if (parsed.pathname === "/v2/_catalog")
        return method === "GET" && parsed.search === "?n=10000" ? undefined : "catalog";
      const match = /^\/v2\/([^/]+)\/([^/]+)\/(tags\/list|manifests\/([^/]+))$/u.exec(
        parsed.pathname,
      );
      if (!match || parsed.search) return "a registry path no stage asks for";
      if (match[1] !== accountId || !repositories.has(match[2])) return "another repository";
      if (match[3] === "tags/list") return method === "GET" ? undefined : "tags";
      return /^(?:[A-Za-z0-9_-]+|sha256%3A[a-f0-9]{64}|sha256:[a-f0-9]{64})$/u.test(match[4]) &&
        ["GET", "DELETE"].includes(method)
        ? undefined
        : "a manifest reference";
    }
    if (parsed.hostname !== "api.cloudflare.com") return "another host";
    const base = `/client/v4/accounts/${accountId}/`;
    if (!parsed.pathname.startsWith(base)) return "another account";
    const rest = parsed.pathname.slice(base.length);
    if (rest === "workers/subdomain")
      return method === "GET" && !parsed.search ? undefined : "subdomain";
    if (rest === "containers/registries/registry.cloudflare.com/credentials")
      return method === "POST" && !parsed.search ? undefined : "credentials";
    for (const [path, { kind, below, readBack }] of Object.entries(COLLECTIONS)) {
      if (rest === path)
        return method === "GET" && /^\?page=\d+&per_page=100$/u.test(parsed.search)
          ? undefined
          : "a listing";
      if (!rest.startsWith(`${path}/`)) continue;
      const [id, ...suffix] = rest.slice(path.length + 1).split("/");
      if (!ids[kind].has(id))
        return readBack && method === "GET" && !suffix.length && !parsed.search && CLEAN.test(id)
          ? undefined
          : `another ${kind} resource`;
      const under = suffix.length ? `/${suffix.join("/")}` : "";
      if (!below.includes(under)) return `a path below ${kind} no stage asks for`;
      const force = kind === "scripts" && method === "DELETE" ? "?force=true" : "";
      return parsed.search === force ? undefined : "a query";
    }
    return "a path no stage asks for";
  };
}

/** Every call `fake` received that `prefix`'s stage may not reach, with why. */
export const outsideCalls = (fake, prefix, reach = stageReach(fake, prefix)) =>
  fake.calls
    .map((call) => ({ call: `${call.method} ${call.url}`, why: reach(call) }))
    .filter((row) => row.why);
