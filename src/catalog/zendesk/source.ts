import { brand } from "../../../brand.ts";
import type { Addition } from "../feed.ts";
import snapshot from "./source.json" with { type: "json" };
import { isZendeskSubdomain } from "./tenant.ts";

const templateExport = 'export default createZendeskApp("example");';

/** Build the one tenant-bound app source served by this catalog Worker. */
export function zendeskAddition(subdomain: string): Addition {
  if (!isZendeskSubdomain(subdomain))
    throw new TypeError("Zendesk subdomain must be one lowercase DNS label");

  let replaced = false;
  const files = snapshot.files.map((file) => {
    if (file.path !== "index.ts") return file;
    if (!file.content.includes(templateExport))
      throw new Error("Zendesk source template changed");
    replaced = true;
    return {
      ...file,
      content: file.content.replace(
        templateExport,
        "export default createZendeskApp(" + JSON.stringify(subdomain) + ");",
      ),
    };
  });
  if (!replaced) throw new Error("Zendesk source entrypoint is missing");

  return {
    entry: {
      id: "zendesk",
      package: snapshot.package,
      name: "Zendesk",
      description:
        "Connect your own Zendesk user to list and read tickets; ticket creation requires approval.",
      auth: [{ method: "oauth", kind: "oauth2" }],
      icons: [],
      source: "apps/zendesk.json",
      connectionNotices: [
        {
          providerName: "Zendesk",
          message:
            "Connect your own Zendesk user through " +
            brand.name +
            ". Access follows that user's Zendesk permissions, and ticket creation requires approval.",
        },
      ],
    },
    source: { package: snapshot.package, files },
  };
}
