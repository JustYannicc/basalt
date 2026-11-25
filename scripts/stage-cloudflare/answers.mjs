// How the stage's choke point (request.mjs) reads what Cloudflare and its registry answer. Every
// reader fails closed: a refused call, a `success: false` envelope, a listing without its array or a
// registry list with a further page throws, so a wrong template or a missing permission never reads
// as an empty account. Refusals carry only the operation, the status, the error codes and known
// field names; remote messages and pointers may hold secrets. Nothing here sends a request.

export const DIGEST = /^sha256:[a-f0-9]{64}$/u;
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
/** Whether the stage module raised the error itself, so its message holds no remote text. */
export const isCloudflareApiError = (error) => own.has(error);
export const fail = (message) => {
  const error = new Error(message);
  own.add(error);
  return error;
};

function refusal(operation, method, status, data) {
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

/** A v4 envelope's data, or null for an absent resource where `absent`; throws on any refusal. */
export async function envelopeOf(response, { label, method, absent }) {
  if (response.status === 404 && absent) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) throw refusal(label, method, response.status, await boundedJson(response));
  let data;
  try {
    data = await response.json();
  } catch {
    // A parse error quotes the body it could not read.
    throw refusal(label, method, response.status, undefined);
  }
  if (data?.success === false) throw refusal(label, method, response.status, data);
  return data;
}

/** The Basic authorization a registry credentials envelope grants. */
export function credentialsOf(data) {
  const username = data?.result?.username ?? data?.result?.user;
  if (data?.success !== true || !username || !data.result?.password)
    throw fail("Registry credentials answered without a username and password");
  return `Basic ${Buffer.from(`${username}:${data.result.password}`).toString("base64")}`;
}

// A registry list that says it has another page could hide one of the stage's repositories or tags.
function singlePage(response, listing) {
  if (/rel="?next"?/u.test(response.headers.get("link") ?? ""))
    throw fail(`The registry ${listing} has more than one page; the check reads only one`);
}
const json = (response) => response.json().catch(() => null);

/** Every repository the registry catalog lists. */
export async function catalogOf(response) {
  if (!response.ok) throw fail(`Registry catalog read failed (HTTP ${response.status})`);
  singlePage(response, "catalog");
  const repositories = (await json(response))?.repositories;
  if (!Array.isArray(repositories))
    throw fail("The registry catalog answered without its repository list");
  if (!repositories.every((repository) => typeof repository === "string"))
    throw fail("The registry catalog lists a repository without a name");
  return repositories;
}

/** The tags one repository holds; none when it is gone. */
export async function tagsOf(response) {
  if (response.status === 404) {
    await response.body?.cancel();
    return [];
  }
  if (!response.ok) throw fail(`Registry tag list failed (HTTP ${response.status})`);
  singlePage(response, "tag list");
  // A repository whose tags are all deleted answers `tags: null`.
  const tags = (await json(response))?.tags ?? [];
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string"))
    throw fail("A registry tag list answered without its tags");
  return tags;
}

/** The digest a manifest read names, and the manifests an index names; undefined once it is gone. */
export async function manifestOf(response) {
  if (response.status === 404) {
    await response.body?.cancel();
    return undefined;
  }
  const digest = response.headers.get("docker-content-digest") ?? "";
  const body = await json(response);
  if (!response.ok || !DIGEST.test(digest) || body === null)
    throw fail(`Registry manifest read failed (HTTP ${response.status})`);
  const children = Array.isArray(body.manifests)
    ? body.manifests.map((entry) => entry?.digest)
    : [];
  if (!children.every((child) => typeof child === "string" && DIGEST.test(child)))
    throw fail("A registry index names a manifest without a digest");
  return { digest, children };
}

/** Whether a manifest delete removed it; one already gone counts as removed. */
export async function deletedOf(response) {
  await response.body?.cancel();
  if (!response.ok && response.status !== 404)
    throw fail(`Registry manifest delete failed (HTTP ${response.status})`);
  return response.ok;
}
