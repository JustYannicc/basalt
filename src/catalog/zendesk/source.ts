import { brand } from "../../../brand.ts";
import type { Addition, FeedAddition, FeedEntry } from "../feed.ts";
import snapshot from "./source.json" with { type: "json" };
import { isZendeskSubdomain } from "./tenant.ts";

const tenantTemplate = 'export const subdomain = "example";';

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
    message: available
      ? `Connect your own Zendesk user through ${brand.name}. Access follows that user's Zendesk permissions, and ticket creation requires approval.`
      : `Zendesk is not set up yet. ${brand.name} must be configured for Zendesk before you can add it.`,
  }],
});

/** Keep setup status visible without publishing a placeholder tenant's source. */
export const unavailableZendeskAddition = (): FeedAddition => ({ entry: entry(false) });

/** Build the one tenant-bound app source served by this catalog Worker. */
export function zendeskAddition(subdomain: string): Addition {
  if (!isZendeskSubdomain(subdomain))
    throw new TypeError("Zendesk subdomain must be one lowercase DNS label");

  let replaced = false;
  const files = snapshot.files.map((file) => {
    if (file.path !== "configuration.ts") return file;
    if (!file.content.includes(tenantTemplate))
      throw new Error("Zendesk source template changed");
    replaced = true;
    return {
      ...file,
      content: file.content.replace(
        tenantTemplate,
        "export const subdomain = " + JSON.stringify(subdomain) + ";",
      ),
    };
  });
  if (!replaced) throw new Error("Zendesk tenant configuration is missing");

  return {
    entry: entry(true),
    source: { package: snapshot.package, files },
  };
}
