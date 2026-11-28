// How the stage's choke point (request.mjs) reads what Cloudflare and its registry answer. An answer
// is read once, the moment it arrives, into a frozen snapshot: its status, the two headers the
// registry readers need, and its body parsed as plain JSON whose every object has no prototype.
// Only a real HTTP Response is read, through Response's own accessors, so nothing the answer object
// itself defines is ever consulted; anything else is refused. Every reader below takes a snapshot
// and fails closed: a refused call, a `success: false` envelope, a listing without its array or a
// registry list with a further page throws, so a wrong template or a missing permission never reads
// as an empty account. Refusals carry only the operation, the status, the error codes and known
// field names; remote messages and pointers may hold secrets. Nothing here sends a request.
import { typeOfManifest } from "./kept-entries.mjs";
import { offersNextIn } from "./link-header.mjs";

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
// A listing page, a Worker's settings or a manifest is far below this; a larger body is not read.
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const own = new WeakSet();
/** Whether the stage module raised the error itself, so its message holds no remote text. */
export const isCloudflareApiError = (error) => own.has(error);
export const fail = (message) => {
  const error = new Error(message);
  own.add(error);
  return error;
};

/** `value[key]` when `value` is an object holding `key` itself; never a prototype's. */
export const ownField = (value, key) =>
  value !== null && typeof value === "object" && Object.hasOwn(value, key) ? value[key] : undefined;
/** `value[key]` when it is the object's own string. */
export const ownString = (value, key) => {
  const field = ownField(value, key);
  return typeof field === "string" ? field : undefined;
};

const accessor = (name) => Object.getOwnPropertyDescriptor(Response.prototype, name).get;
const STATUS = accessor("status");
const HEADERS = accessor("headers");
const BODY = accessor("body");
const HEADER = Headers.prototype.get;

/** Plain JSON in which no object inherits anything, so a missing field reads as undefined. */
const parse = (text) =>
  JSON.parse(text, (_key, value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const copy = Object.create(null);
    for (const field of Object.keys(value)) copy[field] = value[field];
    return copy;
  });

async function bodyText(stream) {
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return undefined;
  }
}

/**
 * The one read of an answer: `{ status, ok, link, digest, data }`, frozen, where `data` is the body
 * as plain JSON, or undefined when the body is empty, too large or not JSON. Refuses anything that
 * is not an HTTP Response.
 */
export async function answerOf(response) {
  let status;
  let headers;
  let stream;
  try {
    status = STATUS.call(response);
    headers = HEADERS.call(response);
    stream = BODY.call(response);
  } catch {
    throw fail("Refused: the answer is not an HTTP response");
  }
  const text = await bodyText(stream).catch(() => undefined);
  let data;
  try {
    data = text ? parse(text) : undefined;
  } catch {
    data = undefined;
  }
  const snapshot = Object.create(null);
  snapshot.status = status;
  snapshot.ok = status >= 200 && status <= 299;
  snapshot.link = HEADER.call(headers, "link") ?? "";
  snapshot.digest = HEADER.call(headers, "docker-content-digest") ?? "";
  snapshot.data = data;
  return Object.freeze(snapshot);
}

function refusal(operation, method, status, data) {
  const listed = ownField(data, "errors");
  const errors = Array.isArray(listed) ? listed.slice(0, 20) : [];
  const codes = [
    ...new Set(errors.map((error) => ownField(error, "code")).filter(Number.isSafeInteger)),
  ];
  const fields = FIELDS.filter((field) =>
    errors.some((error) => {
      const message = ownString(error, "message");
      return message !== undefined && new RegExp(`\\b${field}\\b`).test(message);
    }),
  );
  const error = fail(`Cloudflare ${method} ${operation} failed (${status})`);
  error.diagnostic = { provider: "cloudflare", operation, method, status, codes, fields };
  return error;
}

/** A v4 envelope's data, or null for an absent resource where `absent`; throws on any refusal. */
export function envelopeOf(answer, { label, method, absent }) {
  if (answer.status === 404 && absent) return null;
  if (!answer.ok) throw refusal(label, method, answer.status, answer.data);
  // A body that is not JSON may quote what it could not read, so none of it is kept.
  if (answer.data === undefined) throw refusal(label, method, answer.status, undefined);
  if (ownField(answer.data, "success") === false)
    throw refusal(label, method, answer.status, answer.data);
  return answer.data;
}

/** The Basic authorization a registry credentials envelope grants. */
export function credentialsOf(data) {
  const result = ownField(data, "result");
  const username = ownString(result, "username") ?? ownString(result, "user");
  const password = ownString(result, "password");
  if (ownField(data, "success") !== true || !username || !password)
    throw fail("Registry credentials answered without a username and password");
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

// A registry list that says it has another page could hide one of the stage's repositories or tags.
function singlePage(answer, listing) {
  if (offersNextIn(answer.link))
    throw fail(`The registry ${listing} has more than one page; the check reads only one`);
}

/** Every repository the registry catalog lists. */
export function catalogOf(answer) {
  if (!answer.ok) throw fail(`Registry catalog read failed (HTTP ${answer.status})`);
  singlePage(answer, "catalog");
  const repositories = ownField(answer.data, "repositories");
  if (!Array.isArray(repositories))
    throw fail("The registry catalog answered without its repository list");
  if (!repositories.every((repository) => typeof repository === "string"))
    throw fail("The registry catalog lists a repository without a name");
  return repositories;
}

/**
 * One page of the tags a repository holds, whether the registry offers another, and its Link header
 * as written; `gone` when the repository is not there.
 */
export function tagPageOf(answer) {
  if (answer.status === 404) return { gone: true, missing: false, tags: [], next: false, link: "" };
  if (!answer.ok) throw fail(`Registry tag list failed (HTTP ${answer.status})`);
  if (answer.data === undefined) throw fail("A registry tag list answered without its tags");
  // A repository whose tags are all deleted answers `tags: null`; `missing` is no field at all.
  const field = ownField(answer.data, "tags");
  const tags = field ?? [];
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string"))
    throw fail("A registry tag list answered without its tags");
  // The header goes to the page reader as written; only it decides what may be taken from it.
  return {
    gone: false,
    missing: field === undefined,
    tags,
    next: offersNextIn(answer.link),
    link: answer.link,
  };
}

/** The digest a manifest read names, and the manifests an index names; undefined once it is gone. */
export function manifestOf(answer) {
  if (answer.status === 404) return undefined;
  if (!answer.ok || !DIGEST.test(answer.digest) || answer.data === undefined)
    throw fail(`Registry manifest read failed (HTTP ${answer.status})`);
  const manifests = ownField(answer.data, "manifests");
  const children = Array.isArray(manifests)
    ? manifests.map((entry) => ownField(entry, "digest"))
    : [];
  if (!children.every((child) => typeof child === "string" && DIGEST.test(child)))
    throw fail("A registry index names a manifest without a digest");
  return { digest: answer.digest, children, type: typeOfManifest(answer.data) };
}

/** Whether a manifest delete removed it; one already gone counts as removed. */
export function deletedOf(answer) {
  if (!answer.ok && answer.status !== 404) {
    const errors = ownField(answer.data, "errors");
    const codes = [
      ownField(answer.data, "code"),
      ...(Array.isArray(errors) ? errors : []).map((entry) => ownField(entry, "code")),
    ];
    const error = fail(`Registry manifest delete failed (HTTP ${answer.status})`);
    // Closed facts only: the status, and whether the registry named its one kept code.
    error.refusal = Object.freeze({
      status: answer.status,
      singleton: codes.includes("SINGLETON_ARTIFACT_EXISTS"),
    });
    throw error;
  }
  return answer.ok;
}
