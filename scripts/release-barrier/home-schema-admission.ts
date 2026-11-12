import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import type { HomeMigrationAdmission } from "./home-schema-operation.ts";
import { BarrierRefusal } from "./refusal.ts";

const input = Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/u));
const version = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const codec = Schema.Struct({
  format_version: Schema.Literal(1),
  transitions: Schema.Array(
    Schema.Struct({
      baselineInputHash: input,
      candidateInputHash: input,
      fromVersions: Schema.Array(version).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
      targetVersion: version,
      requiredIndexes: Schema.Array(
        Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,127}$/u)),
      ).check(Schema.isMaxLength(128)),
    }),
  ).check(Schema.isMaxLength(64)),
});

/** A version number alone never admits a write. Both admitted image inputs must match a reviewed pair. */
export async function homeSchemaAdmission(root: string): Promise<HomeMigrationAdmission> {
  let declarations: typeof codec.Type;
  try {
    declarations = Schema.decodeUnknownSync(codec, { onExcessProperty: "error" })(
      JSON.parse(
        await readFile(
          resolve(root, "scripts/release-barrier/home-schema-admissions.json"),
          "utf8",
        ),
      ),
    );
  } catch {
    throw new BarrierRefusal("home-schema-admission-invalid");
  }
  return (identity, info, before) =>
    declarations.transitions.some(
      (entry) =>
        entry.baselineInputHash === identity.baselineInputHash &&
        entry.candidateInputHash === identity.sourceInputHash &&
        before.applied_version !== null &&
        entry.fromVersions.includes(before.applied_version) &&
        entry.targetVersion === info.target_version &&
        entry.requiredIndexes.length === info.required_indexes.length &&
        new Set(entry.requiredIndexes).size === entry.requiredIndexes.length &&
        entry.requiredIndexes.every((name) => info.required_indexes.includes(name)),
    );
}
