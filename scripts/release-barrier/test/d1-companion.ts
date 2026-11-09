import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Effect } from "effect";
import type { Database } from "alchemy/Cloudflare/D1";
import { retain } from "alchemy/RemovalPolicy";
import type { D1Provider } from "../declared-d1-types.ts";

interface TestDatabase extends Resource<
  "Cloudflare.D1Database",
  Database["Props"],
  Database["Attributes"]
> {}
const TestDatabase = Resource<TestDatabase>("Cloudflare.D1Database");
const props = { name: "public-site-waitlist", jurisdiction: "eu" } as const;
export const d1Declaration = {
  action: "create-d1-database",
  type: "Cloudflare.D1Database",
  fqn: "PublicSiteWaitlist",
  props,
  removalPolicy: "retain",
  retention: { data: true, nativeStateRow: true, recoveryDescriptor: true },
} as const;
export function d1Companion(
  events: string[],
  options: { missingPermission?: boolean; unknown?: boolean; readFailsOnce?: boolean } = {},
) {
  let stored: Database["Attributes"] | undefined;
  let failedRead = false;
  const provider: D1Provider = {
    accountId: async () => "fixture",
    preflight: async () => {
      events.push("preflight-d1");
      if (options.missingPermission) throw new Error("synthetic denied D1 read");
    },
    exists: async () => stored !== undefined,
    create: async (target) => {
      events.push("create-d1");
      stored = {
        ...target,
        databaseId: "11111111-1111-4111-8111-111111111111",
        readReplication: undefined,
        migrationsDir: undefined,
        migrationsTable: undefined,
        migrationsHashes: {},
        importHashes: {},
      };
      if (options.unknown) throw new Error("synthetic lost D1 reply");
      return stored.databaseId;
    },
    read: async () => {
      if (stored && options.readFailsOnce && !failedRead) {
        failedRead = true;
        throw new Error("synthetic failed D1 observation");
      }
      return stored;
    },
  };
  return {
    provider,
    resource: TestDatabase("PublicSiteWaitlist", props).pipe(retain()),
    providers: Provider.succeed(TestDatabase, {
      diff: () => Effect.succeed({ action: "noop" }),
      reconcile: () => Effect.die("D1 adoption forbidden"),
      delete: () => Effect.die("D1 deletion forbidden"),
    }),
  };
}
