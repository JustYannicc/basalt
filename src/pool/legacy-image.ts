import { Schema } from "effect";

const Attributes = Schema.Struct({
  accountId: Schema.NonEmptyString,
  applicationId: Schema.NonEmptyString,
  configuration: Schema.Struct({ image: Schema.NonEmptyString }),
  hash: Schema.Struct({
    image: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/u)),
    digest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u)),
  }),
});
const Stored = Schema.Struct({
  status: Schema.Literals(["created", "updated", "updating"]),
  resourceType: Schema.Literal("Cloudflare.Container"),
  logicalId: Schema.Literals([
    "PoolContainer",
    "PoolRuntime",
    "PoolRuntimeBlue",
    "PoolRuntimeGreen",
  ]),
  attr: Schema.optional(Attributes),
  old: Schema.optional(Schema.Struct({ attr: Attributes })),
});

export function retainedLegacyImage(value: unknown) {
  return retainedRuntimeImage(value, "PoolContainer");
}

export function retainedRuntimeImage(value: unknown, logicalId: (typeof Stored.Type)["logicalId"]) {
  if (value === undefined) return undefined;
  try {
    const record = Schema.decodeUnknownSync(Stored)(value);
    if (record.logicalId !== logicalId) throw new Error("different runtime application");
    const attr = record.status === "updating" ? record.old?.attr : record.attr;
    if (!attr) throw new Error("missing retained image");
    const image = attr.configuration.image;
    if (
      !image.startsWith(`registry.cloudflare.com/${attr.accountId}/`) ||
      image.split("@")[1] !== attr.hash.digest
    )
      throw new Error("unconfirmed image");
    return {
      image,
      inputHash: attr.hash.image,
      digest: attr.hash.digest,
      applicationId: attr.applicationId,
    };
  } catch {
    throw new Error("Retained pool image is unavailable or unsettled");
  }
}
