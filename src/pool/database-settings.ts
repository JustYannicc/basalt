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
