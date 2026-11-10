import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { Schema, SchemaIssue } from "effect";
import { publicPropPath } from "./prop-diff.ts";

const paths = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: () => "invalid",
  checkHook: () => "invalid",
});

export function decodeProvisioningInput<A>(schema: Schema.Codec<A>, location: string) {
  const decode = Schema.decodeUnknownSync(schema, { onExcessProperty: "error", errors: "all" });
  return (value: unknown) => {
    try {
      return decode(value);
    } catch (error) {
      const changed = Schema.isSchemaError(error)
        ? paths(error.issue).issues.map((issue) => ({
            path: publicPropPath([
              location,
              ...(issue.path ?? []).map((part) =>
                String(typeof part === "object" ? part.key : part),
              ),
            ]),
            changed: true as const,
          }))
        : [{ path: location, changed: true as const }];
      throw new BarrierRefusal("runtime-private-input-invalid", "PoolRuntime", {
        fqn: "PoolRuntime",
        type: "Cloudflare.Container",
        changed,
        why: [
          "Private runtime inputs must match the reviewed schema; raw settings never enter diagnostics.",
        ],
      });
    }
  };
}

export function provisioningRefusal(
  reason: string,
  path: string,
  expected: unknown,
  observed: unknown,
) {
  return new BarrierRefusal(reason, "PoolRuntime", {
    fqn: "PoolRuntime",
    type: "Cloudflare.Container",
    changed: [
      { path, old: digest(canonical(expected ?? null)), new: digest(canonical(observed ?? null)) },
    ],
    why: ["Provisioning preserves the active runtime and permits only the exact frozen operation."],
  });
}

export function sameProvisioningValue(path: string, expected: unknown, observed: unknown) {
  if (canonical(expected ?? null) !== canonical(observed ?? null))
    throw provisioningRefusal("provisioning-input-drift", path, expected, observed);
}
