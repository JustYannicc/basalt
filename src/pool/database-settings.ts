export const poolDatabase = {
  name: "basalt_pool",
  owner: "basalt_pool_owner",
} as const;

export function previewPoolDatabaseBranch(stage: string): string {
  if (!/^test-pr-[1-9][0-9]*$/.test(stage))
    throw new Error("The pool database branch is restricted to PR preview stages");
  return `${stage}-pool`;
}

export function poolDatabaseUrl(connectionUrl: string): string {
  const url = new URL(connectionUrl);
  if (url.port !== "5432" || url.searchParams.get("sslmode") !== "verify-full") {
    throw new Error("The pool requires a direct Postgres connection with verified TLS");
  }
  url.pathname = `/${poolDatabase.name}`;
  url.searchParams.set("options", `-c role=${poolDatabase.owner}`);
  return url.toString();
}

/**
 * PlanetScale logins are `<role>.<branch id>`; the suffix only routes the connection to a branch.
 * Grants need the Postgres role itself, the part before the first dot. Other Postgres logins are the
 * role. The provisioning job still checks the role exists before granting.
 */
export function postgresRoleName(login: string): string {
  const dot = login.indexOf(".");
  if (!login || dot === 0 || dot === login.length - 1) throw new Error("The pool runtime login is malformed");
  return dot === -1 ? login : login.slice(0, dot);
}
