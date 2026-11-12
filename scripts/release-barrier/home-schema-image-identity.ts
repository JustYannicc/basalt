import type { AdmittedHomeImage } from "./home-schema-container.ts";
import { HomeSchemaCommandError } from "./home-schema-operation.ts";
import { BarrierRefusal } from "./refusal.ts";
import { PoolImageMetadataMismatchError } from "../deploy-safety/pool-image-metadata.ts";

type Property = "image.localId" | "image.digest" | "image.configDigest" | "image.platform";
const digest = /^sha256:[a-f0-9]{64}$/;
const platform = /^(?:linux|windows|darwin)\/(?:amd64|arm64|arm|386|ppc64le|s390x|riscv64)$/;
const safe = (property: Property, value: unknown) =>
  value === undefined
    ? "unknown"
    : typeof value === "string" && (property === "image.platform" ? platform : digest).test(value)
      ? value
      : "invalid";

export class HomeImageMismatchError extends HomeSchemaCommandError {
  readonly refusal: BarrierRefusal;
  constructor(property: Property, expected: readonly string[], observed: unknown) {
    super("image-mismatch");
    const required = expected.map((value) => safe(property, value)).join(" or ");
    const actual = safe(property, observed);
    this.refusal = new BarrierRefusal(
      "home-schema-image-mismatch",
      `home ${property} required=${required} observed=${actual}`,
      {
        fqn: "Home",
        type: "HomeImage",
        changed: [{ path: property, old: required, new: actual }],
      },
    );
  }
}

export const homeImageMetadataMismatch = (error: unknown) =>
  error instanceof PoolImageMetadataMismatchError
    ? new HomeImageMismatchError(`image.${error.property}`, [error.expected], error.observed)
    : undefined;

/** Docker's classic store reports config IDs; its containerd store reports root digests. */
export async function assertLocalHomeImage(
  image: AdmittedHomeImage,
  localId: string | undefined,
  metadata: () => Promise<{ digest: string; configDigest: string; platform: string }>,
) {
  if (localId === image.imageConfigDigest) return;
  if (localId !== image.imageDigest)
    throw new HomeImageMismatchError(
      "image.localId",
      [image.imageConfigDigest, image.imageDigest],
      localId,
    );
  const observed = await metadata().catch((error: unknown) => {
    throw homeImageMetadataMismatch(error) ?? error;
  });
  if (observed.digest !== image.imageDigest)
    throw new HomeImageMismatchError("image.digest", [image.imageDigest], observed.digest);
  if (observed.configDigest !== image.imageConfigDigest)
    throw new HomeImageMismatchError(
      "image.configDigest",
      [image.imageConfigDigest],
      observed.configDigest,
    );
  if (observed.platform !== "linux/amd64")
    throw new HomeImageMismatchError("image.platform", ["linux/amd64"], observed.platform);
}
