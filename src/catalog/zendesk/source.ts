import { brand } from "../../../brand.ts";
import type { Addition, FeedEntry } from "../feed.ts";
import snapshot from "./source.json" with { type: "json" };
import type { ZendeskMarketplaceMetadata } from "./metadata.ts";

const entry: FeedEntry = {
  id: "zendesk",
  package: snapshot.package,
  name: "Zendesk",
  description:
    "Connect your own Zendesk user to list and read tickets; ticket creation requires approval.",
  auth: [{ method: "oauth", kind: "oauth2" }],
  icons: [],
  source: "apps/zendesk.json",
};

export function zendeskAddition(metadata?: ZendeskMarketplaceMetadata): Addition {
  const headers = metadata === undefined ? {} : {
    "X-Zendesk-Marketplace-Name": brand.name,
    "X-Zendesk-Marketplace-Organization-Id": metadata.organizationId,
    "X-Zendesk-Marketplace-App-Id": metadata.appId,
  };
  const files = snapshot.files.map(file => file.path === "configuration.ts"
    ? { ...file, content: `export const integrationHeaders: Readonly<Record<string, string>> = ${JSON.stringify(headers)};\n` }
    : file);
  return {
    entry,
    source: { ...snapshot, files },
  };
}
