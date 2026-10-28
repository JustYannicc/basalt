import type { Addition } from "../feed.ts";
import source from "./source.json" with { type: "json" };

/** Package bytes are served by the Catalog Worker and compiled only when a person installs it. */
export const aws: Addition = {
  entry: {
    id: "aws",
    package: source.package,
    name: "AWS",
    description: "AWS caller identity and regional S3 bucket reads with personal access keys.",
    auth: [{ method: "credentials", kind: "secrets", label: "AWS access keys" }],
    icons: [],
    source: "apps/aws.json",
  },
  source,
};
