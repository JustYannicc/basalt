// Which entries of a stage's own registry repository the registry keeps after the stage deletes it.
// An entry is kept by the registry only when all of these hold: it is a digest entry, its manifest
// read by digest has a type on `KEPT_TYPES`, its delete was refused with one of `KEPT_REFUSALS`, and
// no tag is left in the repository. Anything else fails closed: a tag, a manifest that cannot be
// read, an image manifest or index of either family (the stage's own image, or a permission
// problem), any other type, status or code.

/**
 * The registry's own artifact types, and where each was seen.
 * - application/vnd.cloudchamber.btrfs-chain.v1: the chain artifact Cloudflare's registry makes for
 *   each pushed image; its delete is refused with 409 SINGLETON_ARTIFACT_EXISTS. Reported for this
 *   registry by a third party; not yet seen by this stage. The first destroy's record says.
 */
export const KEPT_TYPES = Object.freeze(["application/vnd.cloudchamber.btrfs-chain.v1"]);

/** Image manifests and indexes, in both families: never kept, whatever the refusal. */
export const IMAGE_TYPES = Object.freeze([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
const IMAGE_CONFIGS = new Set([
  "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.container.image.v1+json",
]);

/** The refusals a kept entry's delete may answer. */
export const KEPT_REFUSALS = Object.freeze(["409 SINGLETON_ARTIFACT_EXISTS", "403"]);

/**
 * What a manifest is, from its own body: its artifact type when it names one, else its config's
 * media type when that is not an image's config, else its media type. An image manifest (one whose
 * config is an image config) and an index are their own media type.
 */
export function typeOfManifest(data) {
  const field = (value, key) =>
    value !== null && typeof value === "object" && Object.hasOwn(value, key)
      ? value[key]
      : undefined;
  const artifact = field(data, "artifactType");
  if (typeof artifact === "string") return artifact;
  const config = field(field(data, "config"), "mediaType");
  if (typeof config === "string" && !IMAGE_CONFIGS.has(config)) return config;
  const media = field(data, "mediaType");
  return typeof media === "string" ? media : undefined;
}

/** A type as a record may carry it: one of the two closed lists, `unread`, or `other`. */
export const closedType = (type) =>
  type === undefined
    ? "unread"
    : KEPT_TYPES.includes(type) || IMAGE_TYPES.includes(type)
      ? type
      : "other";

/** The class of a refused delete: status, and the registry's code when it is the one kept code. */
export const refusalClass = (refusal) =>
  refusal === undefined
    ? undefined
    : refusal.singleton && refusal.status === 409
      ? "409 SINGLETON_ARTIFACT_EXISTS"
      : String(refusal.status);

/** Whether a manifest of `type` is one of the registry's own artifacts. */
export const registryArtifact = (type) => type !== undefined && KEPT_TYPES.includes(type);

/** Whether a refused digest entry of `type`, refused as `refusal`, is kept by the registry. */
export const keptByRegistry = (type, refusal) =>
  registryArtifact(type) && KEPT_REFUSALS.includes(refusalClass(refusal) ?? "");
