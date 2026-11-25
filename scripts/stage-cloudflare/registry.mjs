// A stage's images in the account's container registry. Alchemy pushes a container's image to
// `<account>/<application name>` and no destroy removes it, so the stage finds its repositories by
// name and deletes their tagged manifests itself, as the rehearsal teardown does
// (scripts/release/stage-teardown.ts): short-lived credentials, the catalog, each repository's
// tags, then every tagged manifest with the platform manifests an index names.

export const REGISTRY = "registry.cloudflare.com";
const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

/**
 * One registry session. `credentials(permissions)` mints a Basic authorization through the account
 * API; `owned` decides the repository name after the account; `fail` raises a printable error.
 */
export function registrySession({ accountId, credentials, fetcher, signal, owned, fail }) {
  // What each image row `images` returned was when it was found. A delete reads the name and tags
  // from here, never from the row it is handed, so editing a found row reaches nothing else.
  const found = new WeakMap();
  const repositoryPath = (name) => [accountId, name].map(encodeURIComponent).join("/");
  // One credential per permission set; an inventory asks for pull only, a delete for push too.
  const minted = new Map();
  const registry = (path, permissions, init = {}) => {
    const key = permissions.join(",");
    if (!minted.has(key)) minted.set(key, credentials(permissions));
    return minted.get(key).then((authorization) =>
      fetcher(`https://${REGISTRY}/v2/${path}`, {
        ...init,
        headers: { Authorization: authorization, ...init.headers },
        signal: signal(),
      }),
    );
  };
  // A list that says it has another page could hide one of the stage's repositories or tags.
  const singlePage = (response, listing) => {
    if (/rel="?next"?/u.test(response.headers.get("link") ?? ""))
      throw fail(`The registry ${listing} has more than one page; the check reads only one`);
  };
  const json = (response) => response.json().catch(() => null);

  /** The stage's repositories, `<account>/<owned name>` one name deep, with the tags each holds. */
  async function images(permissions = ["pull"]) {
    const catalog = await registry("_catalog?n=10000", permissions);
    if (!catalog.ok) throw fail(`Registry catalog read failed (HTTP ${catalog.status})`);
    singlePage(catalog, "catalog");
    const repositories = (await json(catalog))?.repositories;
    if (!Array.isArray(repositories))
      throw fail("The registry catalog answered without its repository list");
    const rows = [];
    for (const repository of repositories) {
      if (typeof repository !== "string")
        throw fail("The registry catalog lists a repository without a name");
      const [owner, name, ...rest] = repository.split("/");
      if (owner !== accountId || rest.length || !owned(name)) continue;
      const path = repositoryPath(name);
      const tags = await registry(`${path}/tags/list`, permissions);
      let listed = [];
      if (tags.status !== 404) {
        if (!tags.ok) throw fail(`Registry tag list failed (HTTP ${tags.status})`);
        singlePage(tags, "tag list");
        // A repository whose tags are all deleted answers `tags: null`.
        listed = (await json(tags))?.tags ?? [];
        if (!Array.isArray(listed) || !listed.every((tag) => typeof tag === "string"))
          throw fail("A registry tag list answered without its tags");
      } else await tags.body?.cancel();
      const row = { name, path, tags: listed };
      found.set(row, Object.freeze({ name, tags: Object.freeze([...listed]) }));
      rows.push(row);
    }
    return rows;
  }

  async function manifest(path, reference, permissions) {
    const read = await registry(`${path}/manifests/${encodeURIComponent(reference)}`, permissions, {
      headers: { Accept: MANIFEST_TYPES },
    });
    if (read.status === 404) {
      await read.body?.cancel();
      return undefined;
    }
    const digest = read.headers.get("docker-content-digest") ?? "";
    const body = await json(read);
    if (!read.ok || !DIGEST.test(digest) || body === null)
      throw fail(`Registry manifest read failed (HTTP ${read.status})`);
    const children = Array.isArray(body.manifests)
      ? body.manifests.map((entry) => entry?.digest)
      : [];
    if (!children.every((child) => typeof child === "string" && DIGEST.test(child)))
      throw fail("A registry index names a manifest without a digest");
    return { digest, children };
  }

  /** Deletes every tagged manifest of one repository `images` found, the index before its platforms. */
  async function removeImage(image) {
    const record = found.get(image);
    if (!record || !owned(record.name))
      throw fail("Refused: the registry repository is not one this stage found");
    const path = repositoryPath(record.name);
    const write = ["pull", "push"];
    for (const tag of record.tags) {
      const tagged = await manifest(path, tag, write);
      if (!tagged) continue;
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
          throw fail(`Registry manifest delete failed (HTTP ${removed.status})`);
      }
    }
  }

  return { images, removeImage };
}
