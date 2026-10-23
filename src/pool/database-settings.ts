export const poolDatabase = {
  name: "basalt_pool",
  owner: "basalt_pool_owner",
} as const;

export function poolDatabaseUrl(connectionUrl: string): string {
  const url = new URL(connectionUrl);
  if (url.port !== "5432" || url.searchParams.get("sslmode") !== "verify-full") {
    throw new Error("The pool requires a direct Postgres connection with verified TLS");
  }
  url.pathname = `/${poolDatabase.name}`;
  url.searchParams.set("options", `-c role=${poolDatabase.owner}`);
  return url.toString();
}
