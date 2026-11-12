type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const accountTokenWrite = "5bc3f8b21c554832afc660159ab75fa4";
const statuses = ["active", "disabled", "expired"] as const;
type AuditStatus =
  | "invalid_input"
  | "verification_unavailable"
  | "metadata_unavailable"
  | "disabled"
  | "expired"
  | "active_with_account_token_write"
  | "active_without_account_token_write";
export interface TokenAudit {
  status: AuditStatus;
  permissionGroups: string[];
}
const result = (status: AuditStatus, permissionGroups: string[] = []): TokenAudit => ({
  status,
  permissionGroups,
});

/** This diagnostic has no write request and never returns provider errors or free-form metadata. */
export async function auditDeployToken(
  token: string,
  accountId: string,
  fetcher: Fetcher = fetch,
): Promise<TokenAudit> {
  if (!token || !/^[a-f0-9]{32}$/u.test(accountId)) return result("invalid_input");
  const signal = AbortSignal.timeout(20_000);
  const read = async (path: string): Promise<Record<string, unknown> | undefined> => {
    try {
      const response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
        method: "GET",
        redirect: "error",
        signal,
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0,
        text = "";
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 524_288) return;
          text += decoder.decode(next.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader.cancel();
      }
      const body: unknown = JSON.parse(text);
      if (
        !object(body) ||
        body.success !== true ||
        !Array.isArray(body.errors) ||
        body.errors.length !== 0 ||
        !object(body.result)
      )
        return;
      return body.result;
    } catch {
      return;
    }
  };
  let verified = false;
  // Deployments may use either a user-owned or an account-owned token. Both paths only read self metadata.
  for (const root of ["/user", `/accounts/${accountId}`]) {
    const identity = await read(`${root}/tokens/verify`);
    if (
      !identity ||
      typeof identity.id !== "string" ||
      !/^[a-f0-9]{32}$/u.test(identity.id) ||
      !statuses.some((status) => status === identity.status)
    )
      continue;
    verified = true;
    if (identity.status === "disabled" || identity.status === "expired")
      return result(identity.status);
    const metadata = await read(`${root}/tokens/${identity.id}`);
    if (
      !metadata ||
      metadata.id !== identity.id ||
      !Array.isArray(metadata.policies) ||
      metadata.policies.length > 128
    )
      continue;
    if (metadata.status === "disabled" || metadata.status === "expired")
      return result(metadata.status);
    if (metadata.status !== "active") continue;
    const names = new Set<string>();
    let allowed = false,
      denied = false,
      valid = true;
    for (const policy of metadata.policies) {
      if (
        !object(policy) ||
        !["allow", "deny"].includes(String(policy.effect)) ||
        !object(policy.resources) ||
        !Array.isArray(policy.permission_groups) ||
        policy.permission_groups.length > 1_000
      ) {
        valid = false;
        break;
      }
      const applies =
        policy.resources[`com.cloudflare.api.account.${accountId}`] === "*" ||
        policy.resources["com.cloudflare.api.account.*"] === "*";
      for (const group of policy.permission_groups) {
        if (
          !object(group) ||
          typeof group.id !== "string" ||
          typeof group.name !== "string" ||
          !/^[A-Za-z][A-Za-z0-9 :_./()-]{0,127}$/u.test(group.name) ||
          group.name.includes(token)
        ) {
          valid = false;
          break;
        }
        names.add(group.name);
        if (
          applies &&
          group.id === accountTokenWrite &&
          group.name === "Account API Tokens Write"
        ) {
          if (policy.effect === "allow") allowed = true;
          else denied = true;
        }
      }
      if (!valid) break;
    }
    if (valid)
      return result(
        allowed && !denied
          ? "active_with_account_token_write"
          : "active_without_account_token_write",
        [...names].sort(),
      );
  }
  return result(verified ? "metadata_unavailable" : "verification_unavailable");
}
