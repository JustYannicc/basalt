/**
 * Lists, deletes or verifies the managed registry's rehearsal images. Only repositories of the
 * rehearsal stack (`basalt-rehearsal-*`) qualify; production's images never carry that prefix.
 * Self-contained so it runs without a prepared build.
 */
const manifestTypes = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** The repository names a rehearsal owns, from a registry catalog of `account/name` entries. */
export function rehearsalRepositories(catalog: readonly string[], accountId: string): string[] {
  return catalog.filter((repository) => {
    const [account, name, ...rest] = repository.split("/");
    return (
      account === accountId && !!name && rest.length === 0 && name.startsWith("basalt-rehearsal-")
    );
  });
}

export async function rehearsalRegistry(
  mode: "list" | "delete" | "verify",
  input: { accountId: string; token: string },
  fetcher: typeof fetch = fetch,
): Promise<{ repositories: string[]; tags: number; deleted: number }> {
  const minted = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/containers/registries/registry.cloudflare.com/credentials`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        permissions: mode === "delete" ? ["pull", "push"] : ["pull"],
        expiration_minutes: 15,
      }),
    },
  );
  const body = (await minted.json()) as {
    success?: boolean;
    result?: { username?: string; user?: string; password?: string };
  };
  const username = body.result?.username ?? body.result?.user;
  if (!minted.ok || body.success !== true || !username || !body.result?.password)
    throw new Error(`Registry credentials refused with HTTP ${minted.status}`);
  const auth = `Basic ${Buffer.from(`${username}:${body.result.password}`).toString("base64")}`;
  const call = (path: string, init: RequestInit = {}) =>
    fetcher(`https://registry.cloudflare.com/v2/${path}`, {
      ...init,
      headers: { Authorization: auth, ...init.headers },
    });
  const catalog = await call("_catalog?n=10000");
  if (!catalog.ok) throw new Error(`Registry catalog read failed with HTTP ${catalog.status}`);
  const repositories = rehearsalRepositories(
    ((await catalog.json()) as { repositories?: string[] }).repositories ?? [],
    input.accountId,
  );
  let tags = 0;
  let deleted = 0;
  for (const repository of repositories) {
    const path = repository.split("/").map(encodeURIComponent).join("/");
    const listed = await call(`${path}/tags/list`);
    if (listed.status === 404) continue;
    if (!listed.ok) throw new Error(`Registry tag list failed with HTTP ${listed.status}`);
    const found = ((await listed.json()) as { tags?: string[] | null }).tags ?? [];
    for (const tag of found) {
      // The tag list keeps names whose manifest is already gone; only a resolving tag is an image.
      const head = await call(`${path}/manifests/${encodeURIComponent(tag)}`, {
        method: "HEAD",
        headers: { Accept: manifestTypes },
      });
      if (head.status === 404) continue;
      const digest = head.headers.get("docker-content-digest");
      if (!head.ok || !digest || !/^sha256:[a-f0-9]{64}$/u.test(digest))
        throw new Error(`Registry manifest read failed with HTTP ${head.status}`);
      tags += 1;
      if (mode !== "delete") continue;
      const removed = await call(`${path}/manifests/${digest}`, { method: "DELETE" });
      if (!removed.ok && removed.status !== 404)
        throw new Error(`Registry manifest delete failed with HTTP ${removed.status}`);
      deleted += 1;
    }
  }
  if (mode === "verify" && tags > 0) throw new Error("Rehearsal registry images remain");
  return {
    repositories: repositories.map((repository) => repository.split("/")[1]!),
    tags,
    deleted,
  };
}

/** `image:tag` references of rehearsal images from `wrangler containers images list --json`. */
export function rehearsalImageRefs(images: unknown): string[] {
  if (!Array.isArray(images)) throw new Error("Unexpected registry image list");
  return images
    .flatMap((image: { name?: unknown; tags?: unknown }) =>
      typeof image?.name === "string" && Array.isArray(image.tags)
        ? image.tags
            .filter((tag): tag is string => typeof tag === "string")
            .map((tag) => `${image.name as string}:${tag}`)
        : [],
    )
    .filter((ref) => /^basalt-rehearsal-[a-z0-9-]+:[A-Za-z0-9_.-]+$/u.test(ref));
}

if (process.argv[1]?.endsWith("/rehearsal-registry-cleanup.ts") && process.argv[2] === "refs") {
  const { readFileSync } = await import("node:fs");
  const refs = rehearsalImageRefs(JSON.parse(readFileSync(process.argv[3] ?? "", "utf8")));
  console.error(JSON.stringify({ refs: refs.length }));
  if (refs.length) console.log(refs.join("\n"));
} else if (process.argv[1]?.endsWith("/rehearsal-registry-cleanup.ts")) {
  const mode = process.argv[2];
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (
    (mode !== "list" && mode !== "delete" && mode !== "verify") ||
    !accountId ||
    !token ||
    process.env.GITHUB_ACTIONS !== "true"
  ) {
    console.error("Usage (in Actions): rehearsal-registry-cleanup.ts list|delete|verify");
    process.exitCode = 1;
  } else {
    try {
      const result = await rehearsalRegistry(mode, { accountId, token });
      console.log(JSON.stringify({ mode, ...result }));
      if (mode === "delete")
        console.log(
          JSON.stringify({
            mode: "verify",
            ...(await rehearsalRegistry("verify", { accountId, token })),
          }),
        );
    } catch (error) {
      console.error(
        `::error::${error instanceof Error ? error.message : "Rehearsal registry cleanup failed"}`,
      );
      process.exitCode = 1;
    }
  }
}
