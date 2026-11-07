import { Schema, SchemaIssue } from "effect";
import { BarrierRefusal } from "./manifest.ts";
import { changedProps, publicPropPath } from "./prop-diff.ts";

export const containerDrift = (
  reason: string,
  expected: unknown,
  observed: unknown,
  id = "PoolContainer",
) =>
  new BarrierRefusal(reason, id, {
    fqn: id,
    type: "Cloudflare.Container",
    changed: changedProps(expected, observed),
  });

// Default schema messages can include the rejected input. Retain only sanitized paths.
const schemaPaths = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: () => "unsupported",
  checkHook: () => "unsupported",
});
export function unsupportedContainerObservation(error: unknown) {
  const paths = Schema.isSchemaError(error)
    ? schemaPaths(error.issue).issues.map((issue) =>
        publicPropPath(
          (issue.path ?? []).map((part) => String(typeof part === "object" ? part.key : part)),
        ),
      )
    : ["$"];
  return new BarrierRefusal("unsupported-container-observation", "PoolContainer", {
    fqn: "PoolContainer",
    type: "Cloudflare.Container",
    changed: [...new Set(paths)]
      .slice(0, 256)
      .map((path) => ({ path: path || "$", changed: true })),
    why: ["observed setting is unsupported or has an invalid type"],
  });
}
