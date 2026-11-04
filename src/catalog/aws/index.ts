import type { Addition } from "../feed.ts";
import source from "./source.json" with { type: "json" };
import { awsIcons } from "./logo.ts";

/** The managed server exposes AWS services under each caller's existing IAM permissions. */
export const aws: Addition = {
  entry: {
    id: "aws",
    package: source.package,
    name: "AWS",
    description: "Use AWS services with your own AWS identity and existing permissions.",
    auth: [{ method: "oauth", kind: "oauth2" }],
    icons: [...awsIcons],
    source: "apps/aws.json",
  },
  source,
};
