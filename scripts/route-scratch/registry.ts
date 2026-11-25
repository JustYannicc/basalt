/**
 * The scratch stage's image in the account's container registry. Alchemy pushes the gateway's
 * stand-in image to `<account>/<application name>` and no destroy removes it, so the run finds that
 * one repository by its exact name and deletes its tagged manifests itself.
 *
 * The mechanism is the rehearsal teardown's (scripts/release/stage-teardown.ts): short-lived
 * registry credentials, the catalog, each repository's tags, then every tagged manifest with the
 * platform manifests an index names. That one matches rehearsal names only, so this is a copy.
 */
import { gatewayName, type Stage } from "./settings.ts";

export const registryHost = "registry.cloudflare.com";
const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export interface RegistryAccount {
  readonly accountId: string;
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
}
export interface StageImage {
  readonly repository: string;
  readonly path: string;
  readonly tags: readonly string[];
}

/** The repository the stage's gateway image is pushed to, and nothing that merely shares a prefix. */
export const stageRepository = (accountId: string, stage: Stage) =>
  `${accountId}/${gatewayName(stage)}`;

// A list that says it has another page could hide the stage's repository or a tag, and the
// read-back would pass on what it never saw.
const singlePage = (response: Response, what: string) => {
  if (/rel="?next"?/u.test(response.headers.get("link") ?? ""))
    throw new Error(`The registry ${what} has more than one page`);
};

/** A registry session for one stage. Only a delete asks for the right to push (delete). */
export function registrySession(account: RegistryAccount, stage: Stage, mode: "read" | "delete") {
  const fetcher = account.fetch ?? fetch;
  let authorization: Promise<string> | undefined;
  const registry = (path: string, init: RequestInit = {}) => {
    authorization ??= (async () => {
      const response = await fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${account.accountId}/containers/registries/${registryHost}/credentials`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            permissions: mode === "delete" ? ["pull", "push"] : ["pull"],
            expiration_minutes: 15,
          }),
        },
      );
      const body = (await response.json().catch(() => null)) as {
        success?: boolean;
        result?: { username?: string; user?: string; password?: string };
      } | null;
      const username = body?.result?.username ?? body?.result?.user;
      if (!response.ok || body?.success !== true || !username || !body.result?.password)
        throw new Error(`Registry credentials refused with HTTP ${response.status}`);
      return `Basic ${Buffer.from(`${username}:${body.result.password}`).toString("base64")}`;
    })();
    return authorization.then((value) =>
      fetcher(`https://${registryHost}/v2/${path}`, {
        ...init,
        headers: { Authorization: value, ...init.headers },
      }),
    );
  };

  /** The stage's repository with the tags it holds now; none once it is gone. */
  const images = async (): Promise<StageImage[]> => {
    const catalog = await registry("_catalog?n=10000");
    if (!catalog.ok) throw new Error(`Registry catalog read failed with HTTP ${catalog.status}`);
    singlePage(catalog, "catalog");
    const listed = ((await catalog.json()) as { repositories?: string[] }).repositories ?? [];
    const repository = stageRepository(account.accountId, stage);
    if (!listed.includes(repository)) return [];
    const path = repository.split("/").map(encodeURIComponent).join("/");
    const tags = await registry(`${path}/tags/list`);
    if (tags.status === 404) return [];
    if (!tags.ok) throw new Error(`Registry tag list failed with HTTP ${tags.status}`);
    singlePage(tags, "tag list");
    const held = ((await tags.json()) as { tags?: string[] | null }).tags ?? [];
    return held.length ? [{ repository, path, tags: held }] : [];
  };

  /** The digest a reference names, and the manifests an index names; none once it is gone. */
  const manifest = async (path: string, reference: string) => {
    const read = await registry(`${path}/manifests/${encodeURIComponent(reference)}`, {
      headers: { Accept: MANIFEST_TYPES },
    });
    if (read.status === 404) return undefined;
    const digest = read.headers.get("docker-content-digest") ?? "";
    const body = (await read.json().catch(() => null)) as { manifests?: unknown } | null;
    if (!read.ok || !DIGEST.test(digest) || body === null)
      throw new Error(`Registry manifest read failed with HTTP ${read.status}`);
    const children = Array.isArray(body.manifests)
      ? body.manifests.map((entry: { digest?: unknown } | null) => entry?.digest)
      : [];
    if (
      !children.every((child): child is string => typeof child === "string" && DIGEST.test(child))
    )
      throw new Error("A registry index names a manifest without a digest");
    return { digest, children };
  };

  /** Deletes every tagged manifest in the stage's repository, an index before what it names. */
  const removeImages = async (found: readonly StageImage[]) => {
    let deleted = 0;
    for (const { path, tags } of found)
      for (const tag of tags) {
        // Another tag on a digest already deleted.
        const tagged = await manifest(path, tag);
        if (!tagged) continue;
        const digests = [tagged.digest];
        for (let next = 0; next < digests.length; next += 1) {
          const named = next === 0 ? tagged : await manifest(path, digests[next]!);
          for (const child of named?.children ?? [])
            if (!digests.includes(child)) digests.push(child);
        }
        for (const digest of digests) {
          const removed = await registry(`${path}/manifests/${digest}`, { method: "DELETE" });
          if (!removed.ok && removed.status !== 404)
            throw new Error(`Registry manifest delete failed with HTTP ${removed.status}`);
          if (removed.ok) deleted += 1;
        }
      }
    return deleted;
  };

  return { images, removeImages };
}
