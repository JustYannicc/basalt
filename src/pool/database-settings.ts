export const poolDatabase = {
  name: "basalt_pool",
  owner: "basalt_pool_owner",
} as const;

/**
 * PR previews and release rehearsals. Kept inline rather than imported from the preview scripts so
 * the runtime Worker bundle stays free of deploy tooling; the rehearsal bound matches the barrier's.
 */
export const disposableStagePattern = /^test-(?:pr-[1-9][0-9]*|rehearsal-[1-9][0-9]{0,9})$/;

export function previewPoolDatabaseBranch(stage: string): string {
  if (!disposableStagePattern.test(stage))
    throw new Error("The pool database branch is restricted to PR preview and rehearsal stages");
  return `${stage}-pool`;
}

export function poolDatabaseUrl(connectionUrl: string): string {
  const url = new URL(connectionUrl);
  if (
    url.port !== "6432" ||
    url.searchParams.get("sslmode") !== "verify-full" ||
    url.searchParams.has("options")
  ) {
    throw new Error(
      "The pool requires a pooled Postgres connection with verified TLS and no session options",
    );
  }
  url.pathname = `/${poolDatabase.name}`;
  return url.toString();
}

/**
 * PlanetScale logins are `<role>.<branch id>`; the suffix only routes the connection to a branch.
 * Grants need the Postgres role itself, the part before the first dot. Other Postgres logins are the
 * role. The provisioning job still checks the role exists before granting.
 */
export function postgresRoleName(login: string): string {
  const dot = login.indexOf(".");
  if (!login || dot === 0 || dot === login.length - 1)
    throw new Error("The pool runtime login is malformed");
  return dot === -1 ? login : login.slice(0, dot);
}
