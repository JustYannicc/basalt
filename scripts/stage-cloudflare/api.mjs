// The one Cloudflare API caller for isolated test stages. A stage tool names its prefix and gets
// back operations on what that prefix owns; it never gets a raw path. Every operation checks
// ownership before it calls Cloudflare, so no stage can read, change or delete a resource the
// release stack or another stage owns.
//
// It fails closed: a refused call, a `success: false` envelope or a listing without its array
// throws, so a wrong path or a missing permission never reads as an empty account. Refusals carry
// only the operation, the status, the error codes and known field names; remote messages and
// pointers may hold secrets.
import { stageOwnership } from "./ownership.mjs";
import { REGISTRY, registrySession } from "./registry.mjs";

const API = "https://api.cloudflare.com/client/v4";
const FIELDS = [
  "description",
  "strategy",
  "target_configuration",
  "instance_type",
  "step_percentage",
  "image",
  "max_instances",
];
// Refusals are small JSON envelopes; a larger body is cancelled rather than kept.
const REFUSAL_BYTES = 65536;

/**
 * What a stage can hold, where it is listed, and the name ownership is decided on. A namespace
 * belongs to the Worker that defines it; only one whose Worker is gone is judged by its own name.
 * A Worker is addressed by its name, so it alone can be named without being listed first. `below`
 * is every path under one resource a read or change may add; anything else could climb out of it
 * (`/../`, `%2e%2e`), so it is refused.
 */
const KINDS = {
  applications: {
    path: "containers/applications",
    names: (row) => [row.name],
    below: ["", "/rollouts"],
  },
  namespaces: {
    path: "workers/durable_objects/namespaces",
    names: (row) => [row.script ? row.script : row.name],
  },
  scripts: {
    path: "workers/scripts",
    names: (row) => [row.id],
    byName: true,
    below: ["", "/settings"],
    remove: "?force=true",
  },
  drives: { path: "hyperdrive/configs", names: (row) => [row.name] },
  certificates: { path: "mtls_certificates", names: (row) => [row.name] },
};
const COLLECTIONS = [...Object.values(KINDS).map((kind) => kind.path), "workers/subdomain"];
export const WORKER_KINDS = ["applications", "namespaces", "scripts"];

const own = new WeakSet();
/** Whether this module raised the error itself, so its message holds no remote text. */
export const isCloudflareApiError = (error) => own.has(error);
const fail = (message) => {
  const error = new Error(message);
  own.add(error);
  return error;
};

function refusal(path, method, status, data) {
  const collection =
    COLLECTIONS.find(
      (name) => path === name || path.startsWith(`${name}/`) || path.startsWith(`${name}?`),
    ) ?? (path.startsWith("containers/registries/") ? "containers/registries" : "request");
  const operation = collection + (path.endsWith("/rollouts") ? "/rollouts" : "");
  const errors = Array.isArray(data?.errors) ? data.errors.slice(0, 20) : [];
  const codes = [...new Set(errors.map((error) => error?.code).filter(Number.isSafeInteger))];
  const fields = FIELDS.filter((field) =>
    errors.some(
      (error) =>
        typeof error?.message === "string" && new RegExp(`\\b${field}\\b`).test(error.message),
    ),
  );
  const error = fail(`Cloudflare ${method} ${operation} failed (${status})`);
  error.diagnostic = { provider: "cloudflare", operation, method, status, codes, fields };
  return error;
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  let bytes = 0;
  const chunks = [];
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      bytes += value.byteLength;
      if (bytes > REFUSAL_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    // Diagnostics must not hide the original refusal.
  }
  return undefined;
}

/**
 * One stage's view of one account. `prefix` is the stage's (see ownership.mjs); `owns`, when
 * given, narrows it further. Construction throws on a prefix or predicate that could own a
 * release name. `signal` gives each call its deadline.
 */
export function stageCloudflare({
  accountId,
  token,
  prefix,
  owns,
  fetcher = fetch,
  signal = () => AbortSignal.timeout(30_000),
}) {
  let owned;
  try {
    owned = stageOwnership(prefix, owns);
  } catch (error) {
    // ownership.mjs raises only fixed refusals; anything else is not printed.
    const message = String(error?.message);
    throw fail(message.startsWith("Refused stage ") ? message : "Refused stage ownership");
  }
  // What each row this stage listed was when its ownership was checked. Paths are built from the
  // record only, so a row edited after its listing still addresses what was listed.
  const issued = new WeakMap();
  const issue = (kind) => (row) => (
    issued.set(row, Object.freeze({ kind, id: row.id, names: KINDS[kind].names(row) })),
    row
  );

  const call = (path, method, body) =>
    fetcher(`${API}/accounts/${encodeURIComponent(accountId)}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal(),
    });
  async function send(path, method = "GET", body) {
    const response = await call(path, method, body);
    // Only a read of one resource answers absent; a listing or a write never does.
    if (response.status === 404 && method === "GET" && !path.includes("?")) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) throw refusal(path, method, response.status, await boundedJson(response));
    let data;
    try {
      data = await response.json();
    } catch {
      // A parse error quotes the body it could not read.
      throw refusal(path, method, response.status, undefined);
    }
    if (data?.success === false) throw refusal(path, method, response.status, data);
    return data;
  }
  async function list(path) {
    const rows = [];
    for (let page = 1; page <= 100; page++) {
      const data = await send(`${path}?page=${page}&per_page=100`);
      if (!Array.isArray(data?.result)) throw fail("Unrecognized Cloudflare list response");
      rows.push(...data.result);
      if (data.result_info?.total_pages !== undefined) {
        if (page >= data.result_info.total_pages) return rows;
      } else if (data.result.length < 100) return rows;
    }
    throw fail("Cloudflare inventory exceeded pagination limit");
  }

  const kindOf = (kind) => {
    if (!Object.hasOwn(KINDS, kind)) throw fail(`Refused: ${String(kind)} is not a stage resource`);
    return KINDS[kind];
  };
  const ownsRow = (kind, row) => KINDS[kind].names(row).every(owned);
  /** The path of one owned resource, or below it `below`; a refusal before anything is called. */
  function resource(kind, target, below = "") {
    const spec = kindOf(kind);
    if (!(spec.below ?? [""]).includes(below))
      throw fail(`Refused: ${kind} has no ${String(below)} below it a stage may call`);
    if (spec.byName && typeof target === "string") {
      if (!owned(target)) throw fail(`Refused: ${kind} ${target} is not this stage's`);
      return `${spec.path}/${encodeURIComponent(target)}${below}`;
    }
    const listed = issued.get(target);
    if (listed?.kind !== kind || typeof listed.id !== "string" || !listed.names.every(owned))
      throw fail(`Refused: the ${kind} row is not one this stage listed as its own`);
    return `${spec.path}/${encodeURIComponent(listed.id)}${below}`;
  }

  /** The stage's rows of each kind, listed account-wide at once. */
  async function inventory(kinds = WORKER_KINDS) {
    const listed = await Promise.all(kinds.map((kind) => list(kindOf(kind).path)));
    return Object.fromEntries(
      kinds.map((kind, index) => [
        kind,
        listed[index].filter((row) => ownsRow(kind, row)).map(issue(kind)),
      ]),
    );
  }
  /** One owned resource, or below it `path` (`/settings`); null when it does not exist. */
  const read = async (kind, target, path = "") => send(resource(kind, target, path));
  /** A write to one owned resource, or below it `path` (`/rollouts`). */
  const change = async (kind, target, { method, path = "", body }) => {
    if (!["PATCH", "POST", "PUT"].includes(method))
      throw fail(`Refused: ${method} is not a change`);
    return send(resource(kind, target, path), method, body);
  };
  const remove = async (kind, target) =>
    send(`${resource(kind, target)}${KINDS[kind].remove ?? ""}`, "DELETE");

  const registry = registrySession({
    accountId,
    fetcher,
    signal,
    owned,
    fail,
    async credentials(permissions) {
      const data = await send(`containers/registries/${REGISTRY}/credentials`, "POST", {
        permissions,
        expiration_minutes: 15,
      });
      const username = data?.result?.username ?? data?.result?.user;
      if (data?.success !== true || !username || !data.result?.password)
        throw fail("Registry credentials answered without a username and password");
      return `Basic ${Buffer.from(`${username}:${data.result.password}`).toString("base64")}`;
    },
  });

  return {
    prefix,
    owned,
    inventory,
    read,
    change,
    remove,
    images: registry.images,
    removeImage: registry.removeImage,
    /** The account's workers.dev subdomain, from which a stage Worker's origin follows. */
    subdomain: async () => (await send("workers/subdomain"))?.result?.subdomain,
    /**
     * The image every container application in the account runs, and nothing else of it: the
     * scale test finds its frozen pool image here. No row is returned, so none can be changed.
     */
    imageReferences: async () =>
      (await list(KINDS.applications.path))
        .map((row) => row.configuration?.image)
        .filter((image) => typeof image === "string"),
  };
}
