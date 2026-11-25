// The one place a stage tool's request leaves for Cloudflare's API or its container registry.
// `send` takes a structured request, never a path: a declared kind, a declared operation of that
// kind, the row this stage's own listing returned (or, for a Worker, its name), and a body. It builds
// the URL from a fixed template per kind and operation, and refuses before anything is sent unless
// every name in the URL is inside the stage's prefix and no name production's records use, and every
// id in it is the one this stage's own listing recorded for that name, in a strict charset.
// Account-wide reads take nothing from the caller, and their rows are filtered by ownership before
// they are returned. The fetcher is held only here, in send's closure.
//
// It fails closed: a refused call, a `success: false` envelope or a listing without its array
// throws, so a wrong template or a missing permission never reads as an empty account. Refusals
// carry only the operation, the status, the error codes and known field names; remote messages and
// pointers may hold secrets.
import { isProductionName } from "./ownership.mjs";

const API = "https://api.cloudflare.com/client/v4";
export const REGISTRY = "registry.cloudflare.com";
/** What an id or a name may be when it goes into a URL: no separator, dot, escape, query or space. */
export const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
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
const MAX_PAGES = 100;
const PERMISSIONS = { pull: ["pull"], push: ["pull", "push"] };

/**
 * What a stage can hold, the operations a stage may ask of each, and the names ownership is decided
 * on. A namespace belongs to the Worker that defines it; only one whose Worker is gone is judged by
 * its own name. A Worker is addressed by its name, so it alone may be named instead of handed as a
 * listed row. `images` are the registry's repositories; `account` holds the reads that name no
 * resource.
 */
export const KINDS = {
  applications: {
    path: "containers/applications",
    names: (row) => [row?.name],
    operations: ["list", "read", "patch", "rollout", "delete"],
  },
  namespaces: {
    path: "workers/durable_objects/namespaces",
    names: (row) => [row?.script ? row.script : row?.name],
    operations: ["list", "delete"],
  },
  scripts: {
    path: "workers/scripts",
    names: (row) => [row?.id],
    byName: true,
    operations: ["list", "settings", "delete"],
  },
  drives: {
    path: "hyperdrive/configs",
    names: (row) => [row?.name],
    operations: ["list", "delete"],
  },
  certificates: {
    path: "mtls_certificates",
    names: (row) => [row?.name],
    operations: ["list", "delete"],
  },
  images: {
    names: (row) => [row?.name],
    operations: ["list", "tags", "manifest", "deleteManifest"],
  },
  account: { operations: ["subdomain", "imageReferences", "credentials"] },
};
/** How each operation on one resource is sent: method, what follows its id, whether it has a body. */
const ON_RESOURCE = {
  read: { method: "GET", absent: true },
  settings: { method: "GET", below: "/settings", absent: true },
  patch: { method: "PATCH", body: true },
  rollout: { method: "POST", below: "/rollouts", body: true },
  delete: { method: "DELETE" },
};

const own = new WeakSet();
/** Whether this module raised the error itself, so its message holds no remote text. */
export const isCloudflareApiError = (error) => own.has(error);
export const fail = (message) => {
  const error = new Error(message);
  own.add(error);
  return error;
};
const refuse = (message) => fail(`Refused: ${message}`);

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
async function envelopeOf(response, { label, method, absent }) {
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

// A registry list that says it has another page could hide one of the stage's repositories or tags.
function singlePage(response, listing) {
  if (/rel="?next"?/u.test(response.headers.get("link") ?? ""))
    throw fail(`The registry ${listing} has more than one page; the check reads only one`);
}
const json = (response) => response.json().catch(() => null);

/**
 * The choke point for one stage of one account. `owned` is the stage's ownership test
 * (ownership.mjs); `signal` gives each call its deadline. Returns `send(request)`, where a request is
 * `{ kind, operation, target?, reference?, body? }`.
 */
export function stageRequests({ accountId, token, owned, fetcher, signal }) {
  if (typeof accountId !== "string" || !SEGMENT.test(accountId))
    throw refuse("the account id is not one a URL can hold as it is");
  // What each row this stage listed was when its ownership was checked, so a URL is built from the
  // record and a row that changed after its listing is refused.
  const records = new WeakMap();
  const minted = new Map();

  // A listing keeps every row the stage owns, even one no URL could address, so a teardown that
  // cannot reach it still sees it remain; only an addressable name goes into a URL.
  const ownedName = (name) => owned(name) && !isProductionName(name);
  const stageName = (name) => typeof name === "string" && SEGMENT.test(name) && ownedName(name);
  // The fields a row is known by; any of them changed after its listing makes it another row.
  const identity = (row) => JSON.stringify([row.id, row.name, row.script]);
  const record = (kind, row, id = row.id) => {
    const names = KINDS[kind].names(row);
    records.set(row, { kind, id, names, known: identity(row), tags: [], digests: new Set() });
    return row;
  };
  /** The record of a row this stage listed as its own kind, unchanged since; a refusal otherwise. */
  function recorded(kind, row) {
    const entry = typeof row === "object" && row !== null ? records.get(row) : undefined;
    if (!entry || entry.kind !== kind)
      throw refuse(`the ${kind} row is not one this stage listed as its own`);
    if (identity(row) !== entry.known)
      throw refuse(`the ${kind} row changed after this stage listed it`);
    if (!entry.names.every(stageName) || !SEGMENT.test(entry.id))
      throw refuse(`the ${kind} row's name or id is not one this stage may address`);
    return entry;
  }
  async function authorization(access) {
    if (!minted.has(access))
      minted.set(access, send({ kind: "account", operation: "credentials", access }));
    return minted.get(access);
  }

  /** What the request becomes, refused before anything is sent unless every part of it is the stage's. */
  async function plan({ kind, operation, target, reference, body, access, ...rest }) {
    if (typeof kind !== "string" || !Object.hasOwn(KINDS, kind))
      throw refuse(`${String(kind)} is not a stage resource`);
    const spec = KINDS[kind];
    if (typeof operation !== "string" || !spec.operations.includes(operation))
      throw refuse(`${kind} has no ${String(operation)} a stage may ask for`);
    if (Object.keys(rest).length) throw refuse(`a ${kind} ${operation} takes no other fields`);
    const onResource = Object.hasOwn(ON_RESOURCE, operation) ? ON_RESOURCE[operation] : undefined;
    if (body !== undefined && !onResource?.body)
      throw refuse(`a ${kind} ${operation} takes no body`);
    if (reference !== undefined && !["manifest", "deleteManifest"].includes(operation))
      throw refuse(`a ${kind} ${operation} takes no reference`);
    const named = operation === "credentials" ? access !== undefined : access === undefined;
    if (!named || (access !== undefined && !Object.hasOwn(PERMISSIONS, access)))
      throw refuse("registry credentials are minted only for pull or push");
    if (target !== undefined && (kind === "account" || operation === "list"))
      throw refuse(`a ${kind} ${operation} names no resource`);
    const account = `${API}/accounts/${encodeURIComponent(accountId)}`;

    if (kind === "account") {
      if (operation === "subdomain")
        return { label: "workers/subdomain", url: `${account}/workers/subdomain`, method: "GET" };
      if (operation === "credentials")
        return {
          label: "containers/registries",
          url: `${account}/containers/registries/${REGISTRY}/credentials`,
          method: "POST",
          body: { permissions: PERMISSIONS[access], expiration_minutes: 15 },
        };
      return { label: KINDS.applications.path, list: `${account}/${KINDS.applications.path}` };
    }
    if (kind === "images") {
      const registry = `https://${REGISTRY}/v2`;
      if (operation === "list")
        return { registry: "pull", url: `${registry}/_catalog?n=10000`, method: "GET" };
      const entry = recorded(kind, target);
      const repository = `${registry}/${encodeURIComponent(accountId)}/${encodeURIComponent(entry.id)}`;
      if (operation === "tags")
        return { registry: "pull", entry, url: `${repository}/tags/list`, method: "GET" };
      const tag = entry.tags.includes(reference) && SEGMENT.test(reference);
      const digest = entry.digests.has(reference) && DIGEST.test(reference);
      if (operation === "manifest") {
        if (!tag && !digest)
          throw refuse("the manifest is not one this stage found in its own repository");
        return {
          registry: "push",
          entry,
          url: `${repository}/manifests/${encodeURIComponent(reference)}`,
          method: "GET",
          headers: { Accept: MANIFEST_TYPES },
        };
      }
      if (!digest) throw refuse("the manifest is not one this stage read from its own repository");
      // The registry deletes by the digest as written; DIGEST has already allowed only sha256:<hex>.
      return {
        registry: "push",
        entry,
        url: `${repository}/manifests/${reference}`,
        method: "DELETE",
      };
    }
    const collection = `${account}/${spec.path}`;
    if (operation === "list") return { label: spec.path, list: collection, kind };
    let row = target;
    if (spec.byName && typeof target === "string") {
      if (!stageName(target)) throw refuse(`${kind} ${target} is not this stage's`);
      // A name is addressed only as this stage's own listing records it, read now.
      row = (await send({ kind, operation: "list" })).find((listed) => listed.id === target);
      if (!row) {
        if (onResource.absent) return { absent: true };
        throw refuse(`${kind} ${target} is not one this stage listed as its own`);
      }
    }
    const entry = recorded(kind, row);
    const query = kind === "scripts" && operation === "delete" ? "?force=true" : "";
    return {
      label: spec.path + (operation === "rollout" ? "/rollouts" : ""),
      url: `${collection}/${encodeURIComponent(entry.id)}${onResource.below ?? ""}${query}`,
      method: onResource.method,
      absent: onResource.absent,
      body,
    };
  }

  /** The decoded answer to one request; throws before sending on any refusal. */
  async function send(request) {
    const step = await plan(request ?? {});
    if (step.absent && !step.url) return null;
    const headers = step.registry
      ? { Authorization: await authorization(step.registry), ...step.headers }
      : { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const rows = [];
    for (let page = 1; page <= (step.list ? MAX_PAGES : 1); page++) {
      const method = step.method ?? "GET";
      const response = await fetcher(
        step.list ? `${step.list}?page=${page}&per_page=100` : step.url,
        {
          method,
          headers,
          ...(step.body === undefined ? {} : { body: JSON.stringify(step.body) }),
          signal: signal(),
        },
      );
      if (step.registry) return answer(request, step, response);
      const data = await envelopeOf(response, { ...step, method });
      if (!step.list) return answer(request, step, data);
      if (!Array.isArray(data?.result)) throw fail("Unrecognized Cloudflare list response");
      rows.push(...data.result);
      const last =
        data.result_info?.total_pages === undefined
          ? data.result.length < 100
          : page >= data.result_info.total_pages;
      if (last) return answer(request, step, rows);
    }
    throw fail("Cloudflare inventory exceeded pagination limit");
  }

  /** What the caller gets back: only the stage's own rows, recorded; never another resource. */
  async function answer({ kind, operation, reference }, step, data) {
    if (kind === "account") {
      if (operation === "subdomain") return data?.result?.subdomain;
      if (operation === "imageReferences")
        // Image references only, no row: nothing here can be handed back to address a resource.
        return data
          .map((row) => row?.configuration?.image)
          .filter((ref) => typeof ref === "string");
      const username = data?.result?.username ?? data?.result?.user;
      if (data?.success !== true || !username || !data.result?.password)
        throw fail("Registry credentials answered without a username and password");
      return `Basic ${Buffer.from(`${username}:${data.result.password}`).toString("base64")}`;
    }
    if (kind !== "images") {
      if (operation !== "list") return data;
      return data
        .filter((row) => KINDS[kind].names(row).every(ownedName))
        .map((row) => record(kind, row));
    }
    const response = data;
    if (operation === "list") {
      if (!response.ok) throw fail(`Registry catalog read failed (HTTP ${response.status})`);
      singlePage(response, "catalog");
      const repositories = (await json(response))?.repositories;
      if (!Array.isArray(repositories))
        throw fail("The registry catalog answered without its repository list");
      const rows = [];
      for (const repository of repositories) {
        if (typeof repository !== "string")
          throw fail("The registry catalog lists a repository without a name");
        const [owner, name, ...nested] = repository.split("/");
        if (owner === accountId && !nested.length && ownedName(name))
          rows.push(record(kind, { name }, name));
      }
      return rows;
    }
    if (operation === "tags") {
      let listed = [];
      if (response.status === 404) await response.body?.cancel();
      else {
        if (!response.ok) throw fail(`Registry tag list failed (HTTP ${response.status})`);
        singlePage(response, "tag list");
        // A repository whose tags are all deleted answers `tags: null`.
        listed = (await json(response))?.tags ?? [];
        if (!Array.isArray(listed) || !listed.every((tag) => typeof tag === "string"))
          throw fail("A registry tag list answered without its tags");
      }
      step.entry.tags = Object.freeze([...listed]);
      return step.entry.tags;
    }
    if (operation === "deleteManifest") {
      await response.body?.cancel();
      if (!response.ok && response.status !== 404)
        throw fail(`Registry manifest delete failed (HTTP ${response.status})`);
      step.entry.digests.delete(reference);
      return response.ok;
    }
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
    for (const found of [digest, ...children]) step.entry.digests.add(found);
    return { digest, children };
  }

  return send;
}
