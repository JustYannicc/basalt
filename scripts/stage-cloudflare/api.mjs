// The Cloudflare account API as the test stages call it. It fails closed: a refused call, a
// `success: false` envelope or a listing without its array throws, so a wrong path or a missing
// permission never reads as an empty account. Refusals carry only the operation, the status, the
// error codes and known field names; remote messages and pointers may hold secrets.
const API = "https://api.cloudflare.com/client/v4";
const COLLECTIONS = [
  "containers/applications",
  "workers/durable_objects/namespaces",
  "workers/scripts",
  "workers/subdomain",
  "hyperdrive/configs",
  "mtls_certificates",
];
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
const own = new WeakSet();

/** Whether this module raised the error itself, so its message holds no remote text. */
export const isCloudflareApiError = (error) => own.has(error);
const fail = (message) => {
  const error = new Error(message);
  own.add(error);
  return error;
};

/** Names a stage owns: those starting with its prefix and a dash. */
export const ownedBy = (prefix) => (name) =>
  typeof name === "string" && name.startsWith(`${prefix}-`);

function refusal(path, method, status, data) {
  const collection =
    COLLECTIONS.find(
      (name) => path === name || path.startsWith(`${name}/`) || path.startsWith(`${name}?`),
    ) ?? "request";
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
 * One account's API. `signal` gives each call its deadline. `cf` throws on any refusal; `find`
 * reads one resource by its id and answers null only when it does not exist.
 */
export function cloudflareApi({
  accountId,
  token,
  fetcher = fetch,
  signal = () => AbortSignal.timeout(30_000),
}) {
  const call = (path, method, body) =>
    fetcher(`${API}/accounts/${encodeURIComponent(accountId)}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal(),
    });
  async function answer(path, method, response) {
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
  async function cf(path, method = "GET", body) {
    return answer(path, method, await call(path, method, body));
  }
  async function find(path) {
    const response = await call(path, "GET");
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    return answer(path, "GET", response);
  }
  async function list(path) {
    const rows = [];
    for (let page = 1; page <= 100; page++) {
      const data = await find(`${path}?page=${page}&per_page=100`);
      if (!Array.isArray(data?.result)) throw fail("Unrecognized Cloudflare list response");
      rows.push(...data.result);
      if (data.result_info?.total_pages !== undefined) {
        if (page >= data.result_info.total_pages) return rows;
      } else if (data.result.length < 100) return rows;
    }
    throw fail("Cloudflare inventory exceeded pagination limit");
  }
  return { cf, find, list };
}

/** The account's container applications, Durable Object namespaces and Workers, listed at once. */
export const workerListings = (list) => [
  list("containers/applications"),
  list("workers/durable_objects/namespaces"),
  list("workers/scripts"),
];

/**
 * The stage's rows of those listings. A namespace belongs to the stage when its Worker does,
 * unless `ownsNamespace` says otherwise.
 */
export function ownedWorkers(
  [applications, namespaces, scripts],
  owned,
  ownsNamespace = (row) => owned(row.script),
) {
  return {
    applications: applications.filter((row) => owned(row.name)),
    namespaces: namespaces.filter(ownsNamespace),
    scripts: scripts.filter((row) => owned(row.id)),
  };
}
