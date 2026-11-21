import { isRehearsalStage, rehearsalStack } from "../release-barrier/release-stage.ts";

/**
 * A rehearsal's pool builds push images to the account's managed registry, which its stack
 * destroy leaves behind. Repositories are named for their stack and stage, so only this stage's
 * repositories under the rehearsal stack are ever selected.
 */
/**
 * Whether a provider resource name belongs to this rehearsal stage: alchemy's physical names under
 * the rehearsal stack, or the fleet's `basalt-<stage>-` names. The stage must match whole.
 */
export function ownedByStage(name: string, stage: string): boolean {
  if (!isRehearsalStage(stage)) throw new Error("Only rehearsal stages own disposable resources");
  const stageToken = new RegExp(`(?:^|-)${stage.replace(/[^a-z0-9-]/gu, "")}(?:-|$)`, "u");
  return (
    name.startsWith(`basalt-${stage}-`) ||
    (name.startsWith(`${rehearsalStack}-`) && stageToken.test(name))
  );
}

export function stageRepositories(
  catalog: readonly string[],
  accountId: string,
  stage: string,
): string[] {
  if (!isRehearsalStage(stage))
    throw new Error("Registry images are removed only for rehearsal stages");
  return catalog.filter((repository) => {
    const [account, name, ...rest] = repository.split("/");
    return account === accountId && !!name && rest.length === 0 && ownedByStage(name, stage);
  });
}

type Registry = { username: string; password: string };
const manifestTypes = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

async function registryCredentials(
  accountId: string,
  token: string,
  fetcher: typeof fetch,
): Promise<Registry> {
  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/containers/registries/registry.cloudflare.com/credentials`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ permissions: ["pull", "push"], expiration_minutes: 15 }),
    },
  );
  const body = (await response.json()) as {
    success?: boolean;
    result?: { username?: string; user?: string; password?: string };
  };
  const username = body.result?.username ?? body.result?.user;
  if (!response.ok || body.success !== true || !username || !body.result?.password)
    throw new Error(`Registry credentials refused with HTTP ${response.status}`);
  return { username, password: body.result.password };
}

/** Deletes every manifest in this stage's repositories, or (verify) refuses if any tag remains. */
export async function stageImages(
  mode: "delete" | "verify",
  input: { accountId: string; token: string; stage: string },
  fetcher: typeof fetch = fetch,
): Promise<{ repositories: string[]; deleted: number }> {
  const registry = await registryCredentials(input.accountId, input.token, fetcher);
  const auth = `Basic ${Buffer.from(`${registry.username}:${registry.password}`).toString("base64")}`;
  const call = (path: string, init: RequestInit = {}) =>
    fetcher(`https://registry.cloudflare.com/v2/${path}`, {
      ...init,
      headers: { Authorization: auth, ...init.headers },
    });
  const catalog = await call("_catalog?n=10000");
  if (!catalog.ok) throw new Error(`Registry catalog read failed with HTTP ${catalog.status}`);
  const repositories = stageRepositories(
    ((await catalog.json()) as { repositories?: string[] }).repositories ?? [],
    input.accountId,
    input.stage,
  );
  let deleted = 0;
  for (const repository of repositories) {
    const path = repository.split("/").map(encodeURIComponent).join("/");
    const listed = await call(`${path}/tags/list`);
    if (listed.status === 404) continue;
    if (!listed.ok) throw new Error(`Registry tag list failed with HTTP ${listed.status}`);
    const tags = ((await listed.json()) as { tags?: string[] | null }).tags ?? [];
    if (mode === "verify") {
      if (tags.length) throw new Error("Rehearsal registry images remain");
      continue;
    }
    for (const tag of tags) {
      const head = await call(`${path}/manifests/${encodeURIComponent(tag)}`, {
        method: "HEAD",
        headers: { Accept: manifestTypes },
      });
      const digest = head.headers.get("docker-content-digest");
      if (head.status === 404) continue;
      if (!head.ok || !digest || !/^sha256:[a-f0-9]{64}$/u.test(digest))
        throw new Error(`Registry manifest read failed with HTTP ${head.status}`);
      const removed = await call(`${path}/manifests/${digest}`, { method: "DELETE" });
      if (!removed.ok && removed.status !== 404)
        throw new Error(`Registry manifest delete failed with HTTP ${removed.status}`);
      deleted += 1;
    }
  }
  return { repositories, deleted };
}
