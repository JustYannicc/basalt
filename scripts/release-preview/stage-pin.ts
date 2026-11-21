/**
 * A lane's explicit root pin, composed at run time: the repository variable holds the repository,
 * digest and build input (no account), and the account comes from the `CLOUDFLARE_ACCOUNT_ID`
 * secret, so the full reference only ever exists inside the job, masked.
 */
export function composeRootPin(parts: string | undefined, accountId: string | undefined) {
  if (!parts?.trim()) return undefined;
  const parsed = (() => {
    try {
      return JSON.parse(parts) as { repository?: unknown; digest?: unknown; input?: unknown };
    } catch {
      return undefined;
    }
  })();
  const repository = typeof parsed?.repository === "string" ? parsed.repository : "";
  const digest = typeof parsed?.digest === "string" ? parsed.digest : "";
  const input = typeof parsed?.input === "string" ? parsed.input : "";
  if (
    !/^[a-z0-9][a-z0-9_.-]*(?:\/[a-z0-9][a-z0-9_.-]*)*$/u.test(repository) ||
    !/^sha256:[a-f0-9]{64}$/u.test(digest) ||
    !/^[a-f0-9]{16}$/u.test(input)
  )
    throw new Error(
      "The lane's root image is not {repository, digest: sha256:<64 hex>, input: <16 hex>}",
    );
  if (!/^[a-f0-9]{32}$/u.test(accountId ?? ""))
    throw new Error("The lane's root pin needs the account id secret");
  return JSON.stringify({
    image: `registry.cloudflare.com/${accountId}/${repository}@${digest}`,
    input,
  });
}
