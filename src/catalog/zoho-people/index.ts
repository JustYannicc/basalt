import type { Addition } from "../feed.ts";
import source from "./source.json" with { type: "json" };
import { peopleConnectionGuidance } from "./guidance.ts";

const icon = source.files.find((file) => file.path === "icon.ts");
if (!icon) throw new Error("Zoho People source is missing its icon.");
const logo = /data:image\/png;base64,[A-Za-z0-9+/=]+/.exec(icon.content)?.[0];
if (!logo) throw new Error("Zoho People source has an invalid icon.");

export const zohoPeople: Addition = {
  entry: {
    id: "zoho-people",
    package: source.package,
    name: "Zoho People",
    description:
      "Manage employee records, forms, attendance, shifts, leave, projects, jobs, clients, timesheets and time logs.",
    auth: [
      { method: "oauthEu", kind: "oauth2", label: "Europe (EU)" },
      { method: "oauthUs", kind: "oauth2", label: "United States (US)" },
      { method: "oauthIn", kind: "oauth2", label: "India (IN)" },
      { method: "mcp", kind: "oauth2", label: "Zoho MCP (optional)" },
    ],
    connectionGuidance: peopleConnectionGuidance,
    icons: [{ src: logo, mimeType: "image/png" }],
    source: "apps/zoho-people.json",
  },
  source,
};
