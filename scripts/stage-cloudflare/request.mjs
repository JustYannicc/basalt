// The one place a stage tool's request leaves for Cloudflare's API or its container registry.
// `stageRequests` takes the stage's registered prefix, never an ownership test: it derives that
// itself (ownership.mjs). `send` takes a structured request, never a path: a declared kind, a
// declared operation of that kind, the row this stage's own listing returned (or, for a Worker, its
// name), and a body checked against its operation's exact schema (bodies.mjs). It builds the URL
// from a fixed template per kind and operation, and refuses before anything is sent unless every
// name in the URL is inside the stage's prefix and no name production's records use, and every id
// in it is the one this stage's own listing recorded for that name, in a strict charset. A resource
// addressed by id is read back by that id first, and is changed or deleted only when the answer
// names the recorded, owned name. Every request refuses redirects, and any redirect answer is
// refused, so a request reaches only the URL checked here. Account-wide reads take nothing from the
// caller, and their rows are filtered by ownership before they are returned. Registry credentials
// are minted and used here and never returned. Every table below has no prototype, and every field
// of a request, an option or an answer is read as the object's own, so nothing set on
// Object.prototype changes a request. The fetcher is held only here, in send's closure; answers.mjs
// reads what comes back, once, failing closed.
//
// Not defended: code in the same process (it can replace the fetcher or the runtime itself), and a
// caller-supplied fetcher that ignores the request's redirect mode. The fetcher is the transport
// this module trusts with every request; every real caller passes the global fetch unchanged.
import {
  DIGEST,
  answerOf,
  catalogOf,
  credentialsOf,
  deletedOf,
  envelopeOf,
  fail,
  manifestOf,
  ownField,
  ownString,
} from "./answers.mjs";
import { checkedBody, recordedConfiguration } from "./bodies.mjs";
import { isProductionName, stageOwnership } from "./ownership.mjs";
import { KEPT_TYPES } from "./kept-entries.mjs";
import { readTagPages, TAG } from "./tag-pages.mjs";

const API = "https://api.cloudflare.com/client/v4";
const REGISTRY = "registry.cloudflare.com";
/** What an id or a name may be when it goes into a URL: no separator, dot, escape, query or space. */
const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/u;
/** How many tags the first tag-list page asks for; later pages follow the registry's next link. */
const TAG_PAGE = 1000;
const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  // So a registry that serves its own artifacts under their own type still answers the read.
  ...KEPT_TYPES,
].join(", ");
const MAX_PAGES = 100;

/** A frozen table with no prototype, holding only `entries`' own fields. */
const table = (entries) => Object.freeze(Object.assign(Object.create(null), entries));
const kindOf = ({ path = "", owner, byName = false, readBack = false, operations }) =>
  table({ path, owner, byName, readBack, operations: Object.freeze(operations) });

/**
 * What a stage can hold, the operations a stage may ask of each, and the field ownership is decided
 * on. A namespace belongs to the Worker that defines it (only one whose Worker is gone is judged by
 * its own name) and is never addressed: deleting its Worker deletes it. A Worker is addressed by its
 * name, so it alone may be named instead of handed as a listed row. A kind addressed by an opaque id
 * is read back by that id before any change. `images` are the registry's repositories; `account`
 * holds the reads that name no resource.
 */
export const KINDS = table({
  applications: kindOf({
    path: "containers/applications",
    owner: "name",
    readBack: true,
    operations: ["list", "read", "patch", "rollout", "delete"],
  }),
  namespaces: kindOf({
    path: "workers/durable_objects/namespaces",
    owner: "script",
    operations: ["list"],
  }),
  scripts: kindOf({
    path: "workers/scripts",
    owner: "id",
    byName: true,
    operations: ["list", "settings", "delete"],
  }),
  drives: kindOf({
    path: "hyperdrive/configs",
    owner: "name",
    readBack: true,
    operations: ["list", "delete"],
  }),
  certificates: kindOf({
    path: "mtls_certificates",
    owner: "name",
    readBack: true,
    operations: ["list", "delete"],
  }),
  images: kindOf({ owner: "name", operations: ["list", "tags", "manifest", "deleteManifest"] }),
  account: kindOf({ operations: ["subdomain", "imageReferences"] }),
});
/** How each operation on one resource is sent: method, what follows its id, whether it has a body. */
const ON_RESOURCE = table({
  read: table({ method: "GET", below: "", absent: true, body: false }),
  settings: table({ method: "GET", below: "/settings", absent: true, body: false }),
  patch: table({ method: "PATCH", below: "", absent: false, body: true }),
  rollout: table({ method: "POST", below: "/rollouts", absent: false, body: true }),
  delete: table({ method: "DELETE", below: "", absent: false, body: false }),
});
const PERMISSIONS = table({ pull: Object.freeze(["pull"]), push: Object.freeze(["pull", "push"]) });
const REQUEST_FIELDS = Object.freeze(["kind", "operation", "target", "reference", "body"]);
const OPTIONS = Object.freeze([
  "accountId",
  "token",
  "prefix",
  "owns",
  "fetcher",
  "signal",
  "deadline",
  "now",
]);
/** The longest one request may take: its own abort deadline. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Every field a step has, each set here, so none is ever looked up anywhere else. */
const STEP = table({
  label: "",
  url: "",
  list: "",
  method: "GET",
  absent: false,
  body: undefined,
  registry: "",
  accept: "",
  entry: undefined,
});
const step = (fields) => table({ ...STEP, ...fields });

const refuse = (message) => fail(`Refused: ${message}`);

/** A path segment that is `.` or `..`, written plainly or percent-encoded. */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/iu;
/**
 * The last check before a URL is sent, kept whatever the checks before it already prove: the URL
 * must read back exactly as it was built, and no segment of its path may be a dot segment. Exported
 * only so its refusals can be tested directly; it sends nothing.
 */
export function unchangedWhenParsed(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw refuse("the request's URL does not parse");
  }
  if (parsed.href !== url) throw refuse("the request's URL changes when it is parsed");
  if (parsed.pathname.split("/").some((segment) => DOT_SEGMENT.test(segment)))
    throw refuse("the request's URL holds a dot segment");
  return url;
}

/**
 * Why no URL may be built from a recorded row, or undefined when one may: its name must be one
 * `mayAddress` accepts and its id a plain segment, and a Worker, which has no read-back and is
 * addressed by its name, must be recorded under that name as its id. Exported only so its refusals
 * can be tested directly; it sends nothing.
 */
export function unaddressable(kind, entry, mayAddress) {
  if (!mayAddress(entry.name) || typeof entry.id !== "string" || !SEGMENT.test(entry.id))
    return `the ${kind} row's name or id is not one this stage may address`;
  if (KINDS[kind].byName && entry.id !== entry.name)
    return `the ${kind} ${entry.name} is recorded under another id`;
  return undefined;
}

/** `value`'s own fields, each read once, refused unless every one is in `allowed`. */
function ownFields(value, allowed, what) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw refuse(`a ${what} is an object of named fields`);
  const fields = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key))
      throw refuse(`a ${what} takes no ${String(key)} field`);
    fields[key] = value[key];
  }
  return fields;
}

/**
 * The choke point for one stage of one account: `{ send, owned, prefix }`. `prefix` is the stage's
 * registered prefix and `owns`, when given, narrows it (ownership.mjs); construction throws on
 * either refusal. `signal` gives each call its deadline. `deadline`, an epoch time in
 * milliseconds read against `now`, bounds the whole run: no request starts unless a full request
 * timeout still fits before it, so every request ends by the deadline. `send(request)` takes
 * `{ kind, operation, target?, reference?, body? }`.
 */
export function stageRequests(options) {
  const given = ownFields(options, OPTIONS, "stage");
  const { accountId, token, prefix, owns } = given;
  const fetcher = given.fetcher === undefined ? fetch : given.fetcher;
  const signal =
    given.signal === undefined ? () => AbortSignal.timeout(REQUEST_TIMEOUT_MS) : given.signal;
  const now = given.now === undefined ? Date.now : given.now;
  const { deadline } = given;
  if (typeof fetcher !== "function" || typeof signal !== "function" || typeof now !== "function")
    throw refuse("the fetcher, the signal and the clock are functions");
  if (deadline !== undefined && !Number.isSafeInteger(deadline))
    throw refuse("the deadline is an epoch time in milliseconds");
  if (typeof accountId !== "string" || !SEGMENT.test(accountId))
    throw refuse("the account id is not one a URL can hold as it is");
  let owned;
  try {
    owned = stageOwnership(prefix, owns);
  } catch (error) {
    // ownership.mjs raises only fixed refusals; anything else is not printed.
    const message = String(ownField(error, "message"));
    throw fail(message.startsWith("Refused stage ") ? message : "Refused stage ownership");
  }
  const account = `${API}/accounts/${encodeURIComponent(accountId)}`;
  // What each row this stage listed was when its ownership was checked, so a URL is built from the
  // record and a row that changed after its listing is refused.
  const records = new WeakMap();
  const minted = new Map();

  // A listing keeps every row the stage owns, even one no URL could address, so a teardown that
  // cannot reach it still sees it remain; only an addressable name goes into a URL.
  const ownedName = (name) => owned(name) && !isProductionName(name);
  const stageName = (name) => typeof name === "string" && SEGMENT.test(name) && ownedName(name);
  /** The fields a row is known by, read once from its own fields; any change makes it another row. */
  const snapshot = (row) =>
    table({
      id: ownString(row, "id"),
      name: ownString(row, "name"),
      script: ownString(row, "script"),
    });
  const sameRow = (a, b) => a.id === b.id && a.name === b.name && a.script === b.script;
  const ownerOf = (kind, known) =>
    KINDS[kind].owner === "script"
      ? known.script
        ? known.script
        : known.name
      : known[KINDS[kind].owner];
  const record = (kind, row) => {
    const known = snapshot(row);
    const entry = Object.create(null);
    entry.kind = kind;
    entry.id = kind === "images" ? known.name : known.id;
    entry.name = ownerOf(kind, known);
    entry.known = known;
    // What a change may send is checked against this, never against the row as it is later.
    entry.configuration =
      kind === "applications" ? recordedConfiguration(ownField(row, "configuration")) : undefined;
    entry.tags = Object.freeze([]);
    entry.digests = new Set();
    records.set(row, entry);
    return row;
  };
  /** The record of a row this stage listed as its own kind, unchanged since; a refusal otherwise. */
  function recorded(kind, row) {
    const entry = typeof row === "object" && row !== null ? records.get(row) : undefined;
    if (!entry || entry.kind !== kind)
      throw refuse(`the ${kind} row is not one this stage listed as its own`);
    if (!sameRow(snapshot(row), entry.known))
      throw refuse(`the ${kind} row changed after this stage listed it`);
    const refused = unaddressable(kind, entry, stageName);
    if (refused) throw refuse(refused);
    return entry;
  }

  /**
   * The one call of the fetcher: an init with no prototype that refuses redirects, and the answer
   * read once. A redirect answer a transport hands back anyway is refused: the location was never
   * checked.
   */
  async function exchange(url, method, label, headers, body) {
    unchangedWhenParsed(url);
    // A request that might outlast the run's deadline is not started: a run ends between requests,
    // never in one, so a job's own time limit never cuts a delete.
    if (deadline !== undefined && now() + REQUEST_TIMEOUT_MS > deadline)
      throw fail(`${method} ${label} was not sent: the run's time budget is spent`);
    const init = Object.create(null);
    init.method = method;
    init.headers = headers;
    init.redirect = "error";
    init.signal = signal();
    if (body !== undefined) init.body = JSON.stringify(body);
    let response;
    try {
      response = await fetcher(url, init);
    } catch {
      // A transport's own error can name the full URL, which holds the account id.
      throw fail(`${method} ${label} could not be sent`);
    }
    const answer = await answerOf(response);
    if (answer.status < 200 || (answer.status >= 300 && answer.status <= 399))
      throw refuse(
        `${method} ${label} answered a redirect (HTTP ${answer.status}); a stage request is never redirected`,
      );
    return answer;
  }
  const bearer = () =>
    table({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
  const v4 = async (url, method, label, { absent = false, body } = {}) =>
    envelopeOf(await exchange(url, method, label, bearer(), body), { label, method, absent });

  /** A registry authorization for `access`, minted once and never handed out. */
  function authorization(access) {
    if (!minted.has(access))
      minted.set(
        access,
        v4(
          `${account}/containers/registries/${REGISTRY}/credentials`,
          "POST",
          "containers/registries",
          {
            body: { permissions: PERMISSIONS[access], expiration_minutes: 15 },
          },
        ).then(credentialsOf),
      );
    return minted.get(access);
  }

  /**
   * What `entry`'s id answers now, when it names the recorded, owned name (and that id, where the
   * answer carries one); null for an absent resource where `absent`; a refusal otherwise.
   */
  async function readBack(kind, entry, absent) {
    const spec = KINDS[kind];
    const data = await v4(
      `${account}/${spec.path}/${encodeURIComponent(entry.id)}`,
      "GET",
      spec.path,
      {
        absent,
      },
    );
    if (data === null) return null;
    const result = ownField(data, "result");
    const name = ownString(result, spec.owner);
    const id = ownField(result, "id");
    if (name !== entry.name || !stageName(name) || (id !== undefined && id !== entry.id))
      throw refuse(`the ${kind} ${entry.name} is not what its id answers for`);
    return data;
  }

  /** What the request becomes, refused before anything is sent unless every part of it is the stage's. */
  async function plan(fields) {
    const { kind, operation, target, reference, body } = fields;
    if (typeof kind !== "string" || !Object.hasOwn(KINDS, kind))
      throw refuse(`${String(kind)} is not a stage resource`);
    const spec = KINDS[kind];
    if (typeof operation !== "string" || !spec.operations.includes(operation))
      throw refuse(`${kind} has no ${String(operation)} a stage may ask for`);
    const onResource = Object.hasOwn(ON_RESOURCE, operation) ? ON_RESOURCE[operation] : undefined;
    if (body !== undefined && onResource?.body !== true)
      throw refuse(`a ${kind} ${operation} takes no body`);
    if (reference !== undefined && operation !== "manifest" && operation !== "deleteManifest")
      throw refuse(`a ${kind} ${operation} takes no reference`);
    if (target !== undefined && (kind === "account" || operation === "list"))
      throw refuse(`a ${kind} ${operation} names no resource`);

    if (kind === "account") {
      if (operation === "subdomain")
        return step({ label: "workers/subdomain", url: `${account}/workers/subdomain` });
      return step({
        label: KINDS.applications.path,
        list: `${account}/${KINDS.applications.path}`,
      });
    }
    if (kind === "images") {
      const registry = `https://${REGISTRY}/v2`;
      if (operation === "list")
        return step({ registry: "pull", url: `${registry}/_catalog?n=10000` });
      const entry = recorded(kind, target);
      const repository = `${registry}/${encodeURIComponent(accountId)}/${encodeURIComponent(entry.id)}`;
      if (operation === "tags")
        return step({ registry: "pull", entry, url: `${repository}/tags/list?n=${TAG_PAGE}` });
      const tag =
        typeof reference === "string" && entry.tags.includes(reference) && TAG.test(reference);
      const digest =
        typeof reference === "string" && entry.digests.has(reference) && DIGEST.test(reference);
      if (operation === "manifest") {
        if (!tag && !digest)
          throw refuse("the manifest is not one this stage found in its own repository");
        return step({
          registry: "push",
          entry,
          url: `${repository}/manifests/${encodeURIComponent(reference)}`,
          accept: MANIFEST_TYPES,
        });
      }
      if (!digest) throw refuse("the manifest is not one this stage read from its own repository");
      // The registry deletes by the digest as written; DIGEST has already allowed only sha256:<hex>.
      return step({
        registry: "push",
        entry,
        url: `${repository}/manifests/${reference}`,
        method: "DELETE",
      });
    }
    const collection = `${account}/${spec.path}`;
    if (operation === "list") return step({ label: spec.path, list: collection });
    let row = target;
    if (spec.byName && typeof target === "string") {
      if (!stageName(target)) throw refuse(`${kind} ${target} is not this stage's`);
      // A name is addressed only as this stage's own listing records it, read now.
      row = (await send({ kind, operation: "list" })).find(
        (listed) => records.get(listed)?.id === target,
      );
      if (!row) {
        if (onResource.absent) return null;
        throw refuse(`${kind} ${target} is not one this stage listed as its own`);
      }
    }
    const entry = recorded(kind, row);
    const query = kind === "scripts" && operation === "delete" ? "?force=true" : "";
    return step({
      label: spec.path + (operation === "rollout" ? "/rollouts" : ""),
      url: `${collection}/${encodeURIComponent(entry.id)}${onResource.below}${query}`,
      method: onResource.method,
      absent: onResource.absent,
      body: onResource.body ? checkedBody(operation, body, entry.configuration) : undefined,
      entry,
    });
  }

  /** The decoded answer to one request; throws before sending on any refusal. */
  async function send(request) {
    const fields = ownFields(request, REQUEST_FIELDS, "request");
    const { kind, operation, reference } = fields;
    const planned = await plan(fields);
    if (planned === null) return null;
    if (planned.registry) {
      const headers = Object.create(null);
      headers.Authorization = await authorization(planned.registry);
      if (planned.accept) headers.Accept = planned.accept;
      if (operation === "tags") return readTags(planned, headers);
      const answered = await exchange(
        planned.url,
        planned.method,
        `registry ${operation}`,
        headers,
      );
      return registryAnswer(operation, planned, reference, answered);
    }
    if (planned.list) return listing(kind, operation, planned);
    let body = planned.body;
    if (planned.entry && KINDS[kind].readBack) {
      // A read is its own read-back; a change or a delete follows one.
      const found = await readBack(kind, planned.entry, planned.method === "GET");
      if (planned.method === "GET" || found === null) return found;
      // A listing row can lie about its configuration; what its id answers now is the application's.
      // The copy already checked is checked again, so the caller's object is read only once.
      if (body !== undefined)
        body = checkedBody(
          operation,
          body,
          recordedConfiguration(ownField(ownField(found, "result"), "configuration")),
        );
    }
    const data = await v4(planned.url, planned.method, planned.label, {
      absent: planned.absent,
      body,
    });
    return kind === "account" ? ownString(ownField(data, "result"), "subdomain") : data;
  }

  /** Every page of one account-wide listing, then only the stage's own rows, recorded. */
  async function listing(kind, operation, planned) {
    const rows = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await v4(`${planned.list}?page=${page}&per_page=100`, "GET", planned.label);
      const result = ownField(data, "result");
      if (!Array.isArray(result)) throw fail("Unrecognized Cloudflare list response");
      rows.push(...result);
      const total = ownField(ownField(data, "result_info"), "total_pages");
      if (total === undefined ? result.length < 100 : page >= total) {
        // Image references only, no row: nothing here can be handed back to address a resource.
        if (kind === "account")
          return rows
            .map((row) => ownString(ownField(row, "configuration"), "image"))
            .filter((reference) => reference !== undefined);
        return rows
          .filter((row) => ownedName(ownerOf(kind, snapshot(row))))
          .map((row) => record(kind, row));
      }
    }
    throw fail("Cloudflare inventory exceeded pagination limit");
  }

  /** Every tag of one repository, recorded on its entry (tag-pages.mjs reads the pages). */
  async function readTags(planned, headers) {
    const entries = await readTagPages(planned.url, (url) =>
      exchange(url, "GET", "registry tags", headers),
    );
    // A digest entry is addressed only as a manifest of this repository, as a digest read is.
    for (const entry of entries) if (DIGEST.test(entry)) planned.entry.digests.add(entry);
    return (planned.entry.tags = entries);
  }

  /** What a registry answer gives the caller: only the stage's own repositories, and their parts. */
  function registryAnswer(operation, planned, reference, answered) {
    if (operation === "list")
      return catalogOf(answered)
        .map((repository) => repository.split("/"))
        .filter(
          ([owner, name, ...nested]) => owner === accountId && !nested.length && ownedName(name),
        )
        .map(([, name]) => record("images", { name }));
    if (operation === "tags") throw fail("Refused: a tag list is read page by page");
    if (operation === "deleteManifest") {
      const deleted = deletedOf(answered);
      planned.entry.digests.delete(reference);
      return deleted;
    }
    const manifest = manifestOf(answered);
    for (const found of manifest ? [manifest.digest, ...manifest.children] : [])
      planned.entry.digests.add(found);
    return manifest;
  }

  return Object.freeze({ send, owned, prefix });
}
