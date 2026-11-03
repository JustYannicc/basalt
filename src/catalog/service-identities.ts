import aliases from "./service-identities.json" with { type: "json" };
import type { Feed } from "./feed.ts";

const identities: Readonly<Record<string, NonNullable<Feed["apps"][number]["service"]>>> = aliases;

/** Endpoint aliases are publisher data; matching names and domains do not establish identity. */
export function withServiceIdentities(feed: Feed): Feed {
  return {
    ...feed,
    apps: feed.apps.map(entry => ({
      ...entry,
      service: {
        ...entry.service,
        id: identities[entry.package]?.id ?? entry.service?.id ?? entry.package,
        mcp: [...new Set([...(entry.service?.mcp ?? []), ...(identities[entry.package]?.mcp ?? [])])],
        packages: [...new Set([entry.package, ...(entry.service?.packages ?? []), ...(identities[entry.package]?.packages ?? [])])],
      },
    })),
  };
}
