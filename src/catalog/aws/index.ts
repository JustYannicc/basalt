import type { Addition } from "../feed.ts";
import source from "./source.json" with { type: "json" };
import { awsIcons } from "./logo.ts";

/** Package bytes are served by the Catalog Worker and compiled only when a person installs it. */
export const aws: Addition = {
  entry: {
    id: "aws",
    package: source.package,
    name: "AWS",
    description: "Check which AWS account you are connected to and list its S3 buckets in your chosen region.",
    auth: [{ method: "credentials", kind: "secrets", label: "AWS access keys" }],
    icons: [...awsIcons],
    source: "apps/aws.json",
  },
  source,
};
