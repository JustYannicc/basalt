// What the emulated stage has in the account, found and removed only by its name prefix: container
// applications, Workers, the Durable Object namespaces those Workers own, and the registry images its
// deploy pushed. Registry deletion follows the rehearsal teardown (scripts/release/stage-teardown.ts).
import { cloudflareApi, ownedBy, ownedWorkers, workerListings } from "../stage-cloudflare/api.mjs";
import { publicMessage, StageError } from "./public-error.mjs";

const API = "https://api.cloudflare.com/client/v4";
const REGISTRY = "registry.cloudflare.com";
const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export function emulatedAccount({ accountId, token, prefix, fetcher = fetch }) {
  if (!accountId || !token)
    throw new StageError("The emulated upstream needs the deploy credentials");
  const owned = ownedBy(prefix);
  const account = `${API}/accounts/${encodeURIComponent(accountId)}`;
  const bearer = { Authorization: `Bearer ${token}` };
  const { cf, find, list } = cloudflareApi({ accountId, token, fetcher });

  // One credential per permission set; the inventory asks for pull only, the destroy for push too.
  const credentials = new Map();
  const registry = (path, permissions, init = {}) => {
    const key = permissions.join(",");
    if (!credentials.has(key))
      credentials.set(
        key,
        (async () => {
          const response = await fetcher(
            `${account}/containers/registries/${REGISTRY}/credentials`,
            {
              method: "POST",
              headers: { ...bearer, "Content-Type": "application/json" },
              body: JSON.stringify({ permissions, expiration_minutes: 15 }),
              signal: AbortSignal.timeout(30_000),
            },
          );
          const body = await response.json().catch(() => null);
          const username = body?.result?.username ?? body?.result?.user;
          if (!response.ok || body?.success !== true || !username || !body.result?.password)
            throw new StageError(`Registry credentials refused (HTTP ${response.status})`);
          return `Basic ${Buffer.from(`${username}:${body.result.password}`).toString("base64")}`;
        })(),
      );
    return credentials.get(key).then((authorization) =>
      fetcher(`https://${REGISTRY}/v2/${path}`, {
        ...init,
        headers: { Authorization: authorization, ...init.headers },
        signal: AbortSignal.timeout(30_000),
      }),
    );
  };
  // A list that says it has another page could hide one of the stage's repositories or tags.
  const singlePage = (response, listing) => {
    if (/rel="?next"?/u.test(response.headers.get("link") ?? ""))
      throw new StageError(
        `The registry ${listing} has more than one page; the check reads only one`,
      );
  };

  /** The stage's repositories, `<account>/<prefix>-…` one name deep, with the tags each holds. */
  async function images(permissions) {
    const catalog = await registry("_catalog?n=10000", permissions);
    if (!catalog.ok) throw new StageError(`Registry catalog read failed (HTTP ${catalog.status})`);
    singlePage(catalog, "catalog");
    const { repositories } = await catalog.json();
    if (!Array.isArray(repositories))
      throw new StageError("The registry catalog answered without its repository list");
    const found = [];
    for (const repository of repositories) {
      if (typeof repository !== "string")
        throw new StageError("The registry catalog lists a repository without a name");
      const [owner, name, ...rest] = repository.split("/");
      if (owner !== accountId || rest.length || !owned(name)) continue;
      const path = [owner, name].map(encodeURIComponent).join("/");
      const tags = await registry(`${path}/tags/list`, permissions);
      if (tags.status === 404) {
        found.push({ name, path, tags: [] });
        continue;
      }
      if (!tags.ok) throw new StageError(`Registry tag list failed (HTTP ${tags.status})`);
      singlePage(tags, "tag list");
      // A repository whose tags are all deleted answers `tags: null`.
      const listed = (await tags.json()).tags ?? [];
      if (!Array.isArray(listed) || !listed.every((tag) => typeof tag === "string"))
        throw new StageError("A registry tag list answered without its tags");
      found.push({ name, path, tags: listed });
    }
    return found;
  }
  async function manifest(path, reference, permissions) {
    const read = await registry(`${path}/manifests/${encodeURIComponent(reference)}`, permissions, {
      headers: { Accept: MANIFEST_TYPES },
    });
    if (read.status === 404) return undefined;
    const digest = read.headers.get("docker-content-digest") ?? "";
    const body = await read.json().catch(() => null);
    if (!read.ok || !DIGEST.test(digest) || body === null)
      throw new StageError(`Registry manifest read failed (HTTP ${read.status})`);
    const children = Array.isArray(body.manifests)
      ? body.manifests.map((entry) => entry?.digest)
      : [];
    if (!children.every((child) => typeof child === "string" && DIGEST.test(child)))
      throw new StageError("A registry index names a manifest without a digest");
    return { digest, children };
  }

  async function inventory(permissions = ["pull"]) {
    const [applications, namespaces, scripts, repositories] = await Promise.all([
      ...workerListings(list),
      images(permissions),
    ]);
    return {
      ...ownedWorkers([applications, namespaces, scripts], owned),
      // A repository whose tags are all gone holds nothing the registry can still find.
      images: repositories.filter((row) => row.tags.length),
    };
  }
  /** Names only, never ids or values: these lines go to the public log. */
  const describe = (resources) =>
    [
      ...resources.applications.map((row) => `container application ${row.name}`),
      ...resources.scripts.map((row) => `Worker ${row.id}`),
      ...resources.namespaces.map(
        (row) => `Durable Object namespace ${row.class} of ${row.script}`,
      ),
      ...resources.images.map((row) => `registry repository ${row.name} (${row.tags.length} tags)`),
    ].join(", ");
  const empty = (resources) => Object.values(resources).every((rows) => rows.length === 0);

  /** Deletes every prefixed resource, then refuses unless a fresh inventory finds none. */
  async function destroy() {
    const write = ["pull", "push"];
    const before = await inventory(write);
    const failures = [];
    const attempt = async (label, operation) => {
      try {
        await operation();
      } catch (error) {
        failures.push(`${label}: ${publicMessage(error)}`);
      }
    };
    for (const app of before.applications)
      await attempt(`container application ${app.name}`, () =>
        cf(`containers/applications/${encodeURIComponent(app.id)}`, "DELETE"),
      );
    // Deleting a Worker deletes the Durable Object namespaces it owns.
    for (const script of before.scripts)
      await attempt(`Worker ${script.id}`, () =>
        cf(`workers/scripts/${encodeURIComponent(script.id)}?force=true`, "DELETE"),
      );
    for (const { name, path, tags } of before.images)
      await attempt(`registry repository ${name}`, async () => {
        for (const tag of tags) {
          const tagged = await manifest(path, tag, write);
          if (!tagged) continue;
          // An index first, then the platform manifests it names: no tag reaches those afterwards.
          const digests = [tagged.digest];
          for (let next = 0; next < digests.length; next++) {
            const named = next === 0 ? tagged : await manifest(path, digests[next], write);
            for (const child of named?.children ?? [])
              if (!digests.includes(child)) digests.push(child);
          }
          for (const digest of digests) {
            const removed = await registry(`${path}/manifests/${digest}`, write, {
              method: "DELETE",
            });
            await removed.body?.cancel();
            if (!removed.ok && removed.status !== 404)
              throw new StageError(`manifest delete failed (HTTP ${removed.status})`);
          }
        }
      });
    const after = await inventory(write);
    if (!empty(after))
      throw new StageError(
        `Emulated upstream resources remain after teardown: ${describe(after)}${failures.length ? `; failed: ${failures.join("; ")}` : ""}`,
      );
    return { before, failures };
  }

  /** The Worker's DELETE_BY lease in epoch milliseconds, or undefined when it has none. */
  async function lease(worker) {
    // The Worker read by its name: absent only when the account has no such Worker.
    const settings = await find(`workers/scripts/${encodeURIComponent(worker)}/settings`);
    const text = settings?.result?.bindings?.find((row) => row.name === "DELETE_BY")?.text;
    const at = Number(text);
    return Number.isSafeInteger(at) && at > 0 ? at : undefined;
  }

  return { cf, inventory, destroy, lease, describe, empty };
}
