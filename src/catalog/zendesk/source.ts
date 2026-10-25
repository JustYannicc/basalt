import { brand } from "../../../brand.ts";
import type { Addition, FeedEntry } from "../feed.ts";
import snapshot from "./source.json" with { type: "json" };
import type { ZendeskMarketplaceMetadata } from "./metadata.ts";

const entry = (available: boolean): FeedEntry => ({
  id: "zendesk",
  package: snapshot.package,
  name: "Zendesk",
  description:
    "Connect your own Zendesk user to list and read tickets; ticket creation requires approval.",
  auth: [{ method: "oauth", kind: "oauth2" }],
  icons: [],
  source: "apps/zendesk.json",
  connectionNotices: [{
    providerName: "Zendesk",
    message: `Enter your Zendesk site and connect your own user through ${brand.name}. Access follows your Zendesk permissions, and ticket creation requires approval.${available ? "" : " A compatible OAuth client must already be available for your site. You can use your own client under Advanced."}`,
  }],
});

/** Source availability is independent of the operator's optional hosted OAuth client. */
export function zendeskAddition(hostedReady = false, metadata?: ZendeskMarketplaceMetadata): Addition {
  const headers = metadata === undefined ? {} : {
    "X-Zendesk-Marketplace-Name": brand.name,
    "X-Zendesk-Marketplace-Organization-Id": metadata.organizationId,
    "X-Zendesk-Marketplace-App-Id": metadata.appId,
  };
  const files = snapshot.files.map(file => file.path === "configuration.ts"
    ? { ...file, content: `export const integrationHeaders: Readonly<Record<string, string>> = ${JSON.stringify(headers)};\n` }
    : file);
  return {
    entry: entry(hostedReady),
    source: { ...snapshot, files },
  };
}
