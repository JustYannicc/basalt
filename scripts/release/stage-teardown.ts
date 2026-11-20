/**
 * What a rehearsal stage leaves after its stacks are destroyed, removed through the release entry.
 * Its fleet applications are retained by the destroy (production's must be, so the declaration
 * says `retain()`), and its pool builds push images to the account's registry, which no stack
 * records. Both are found by the stage token in their names (`rehearsal-stage.ts`) and deleted one
 * at a time under the wire guard, which proves each target again before it lets a delete leave.
 */
import { isRehearsalStage, stageOwnsName } from "./rehearsal-stage.ts";
import { REGISTRY_HOST } from "./stage-writes.ts";

export interface TeardownInput {
  readonly accountId: string;
  readonly token: string;
  readonly stage: string;
}

const API = "https://api.cloudflare.com/client/v4";
const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

/** The stage's own repositories in this account: `<account>/<name>`, one name component deep. */
export function stageRepositories(
  catalog: ReadonlyArray<string>,
  accountId: string,
  stage: string,
): string[] {
  return catalog.filter((repository) => {
    const [account, name, ...rest] = repository.split("/");
    return account === accountId && !!name && rest.length === 0 && stageOwnsName(name, stage);
  });
}

// A registry list that says it has another page could hide one of the stage's repositories or
// tags, and the absence check would pass on what it never saw.
const singlePage = (response: Response, what: string) => {
  if (/rel="?next"?/u.test(response.headers.get("link") ?? ""))
    throw new Error(`The registry ${what} has more than one page; the teardown reads only one`);
};

const session = (input: TeardownInput, fetcher: typeof fetch) => {
  const account = `${API}/accounts/${encodeURIComponent(input.accountId)}`;
  const bearer = { Authorization: `Bearer ${input.token}` };
  let registryAuth: Promise<string> | undefined;

  const applications = async () => {
    const listed = await fetcher(`${account}/containers/applications`, { headers: bearer });
    const body = (await listed.json().catch(() => null)) as {
      success?: boolean;
      result?: { id?: unknown; name?: unknown }[];
      result_info?: { total_pages?: unknown };
    } | null;
    if (!listed.ok || body?.success !== true || !Array.isArray(body.result))
      throw new Error(`Container application list failed with HTTP ${listed.status}`);
    if (typeof body.result_info?.total_pages === "number" && body.result_info.total_pages > 1)
      throw new Error("The container application list has more than one page");
    return body.result.flatMap((app) =>
      typeof app.id === "string" &&
      typeof app.name === "string" &&
      stageOwnsName(app.name, input.stage)
        ? [{ id: app.id, name: app.name }]
        : [],
    );
  };

  const registry = (path: string, init: RequestInit = {}) => {
    registryAuth ??= (async () => {
      const response = await fetcher(
        `${account}/containers/registries/${REGISTRY_HOST}/credentials`,
        {
          method: "POST",
          headers: { ...bearer, "Content-Type": "application/json" },
          body: JSON.stringify({ permissions: ["pull", "push"], expiration_minutes: 15 }),
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
    return registryAuth.then((authorization) =>
      fetcher(`https://${REGISTRY_HOST}/v2/${path}`, {
        ...init,
        headers: { Authorization: authorization, ...init.headers },
      }),
    );
  };

  /** The stage's repositories with the tags each holds now; a repository already gone holds none. */
  const images = async () => {
    const catalog = await registry("_catalog?n=10000");
    if (!catalog.ok) throw new Error(`Registry catalog read failed with HTTP ${catalog.status}`);
    singlePage(catalog, "catalog");
    const listed = ((await catalog.json()) as { repositories?: string[] }).repositories ?? [];
    const found: { repository: string; path: string; tags: string[] }[] = [];
    for (const repository of stageRepositories(listed, input.accountId, input.stage)) {
      const path = repository.split("/").map(encodeURIComponent).join("/");
      const tags = await registry(`${path}/tags/list`);
      if (tags.status === 404) {
        found.push({ repository, path, tags: [] });
        continue;
      }
      if (!tags.ok) throw new Error(`Registry tag list failed with HTTP ${tags.status}`);
      singlePage(tags, "tag list");
      found.push({
        repository,
        path,
        tags: ((await tags.json()) as { tags?: string[] | null }).tags ?? [],
      });
    }
    return found;
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

  return { account, bearer, applications, registry, images, manifest };
};

/**
 * What the absence check cannot see: the registry lists manifests only by tag, so one pushed by
 * digest alone and never tagged is neither found nor deleted. An index's platform manifests are
 * found through the index, and deleted with it.
 */
export const TEARDOWN_NOT_CHECKED =
  "A registry manifest pushed by digest alone, never tagged, is not checked: the registry lists only tags.";

/**
 * `delete` removes the stage's applications, then every tagged manifest in its repositories with
 * the manifests an index names, and ends with the absence check; `verify` is the check alone. The
 * first failure stops the run: what is left stays for the next run to find by name, and the check
 * refuses while anything remains.
 */
export async function teardownStage(
  mode: "delete" | "verify",
  input: TeardownInput,
  fetcher: typeof fetch,
): Promise<{ applications: string[]; repositories: string[]; manifests: number }> {
  if (!isRehearsalStage(input.stage))
    throw new Error("A teardown runs only on a test-rehearsal-<n> stage");
  if (!input.accountId || !input.token)
    throw new Error("The teardown needs the deploy credentials");
  const cloudflare = session(input, fetcher);
  const deleted = { applications: [] as string[], repositories: [] as string[], manifests: 0 };
  if (mode === "delete") {
    for (const app of await cloudflare.applications()) {
      const removed = await fetcher(
        `${cloudflare.account}/containers/applications/${encodeURIComponent(app.id)}`,
        { method: "DELETE", headers: cloudflare.bearer },
      );
      if (!removed.ok && removed.status !== 404)
        throw new Error(`Container application delete failed with HTTP ${removed.status}`);
      deleted.applications.push(app.name);
    }
    for (const { repository, path, tags } of await cloudflare.images()) {
      deleted.repositories.push(repository);
      for (const tag of tags) {
        // Another tag on a digest already deleted.
        const tagged = await cloudflare.manifest(path, tag);
        if (!tagged) continue;
        // An index first, then the platform manifests it names: no tag reaches those, so once the
        // index is gone nothing would find them again.
        const digests = [tagged.digest];
        for (let next = 0; next < digests.length; next += 1) {
          const named = next === 0 ? tagged : await cloudflare.manifest(path, digests[next]!);
          for (const child of named?.children ?? [])
            if (!digests.includes(child)) digests.push(child);
        }
        for (const digest of digests) {
          const removed = await cloudflare.registry(`${path}/manifests/${digest}`, {
            method: "DELETE",
          });
          if (!removed.ok && removed.status !== 404)
            throw new Error(`Registry manifest delete failed with HTTP ${removed.status}`);
          if (removed.ok) deleted.manifests += 1;
        }
      }
    }
  }
  const remaining = await cloudflare.applications();
  if (remaining.length)
    throw new Error(`${remaining.length} of the stage's container applications remain`);
  if ((await cloudflare.images()).some(({ tags }) => tags.length))
    throw new Error("The stage's tagged registry images remain");
  return deleted;
}
