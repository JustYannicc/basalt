/** The package stays behind its Promise API; its internal dependencies never enter host Effects. */
export * from "./.generated/strata/index.js";
export {
  openCloudflareStorage,
  type Bucket,
  type BucketObject,
} from "./.generated/strata/cloudflare.js";

export { openAttachmentStore, type AttachmentBucket } from "./.generated/strata/attachments.js";
export {
  encodeAttachmentPointer,
  decodeAttachmentPointer,
  sha256,
  incrementalSha256,
  type Attachment,
} from "./.generated/strata/bytes.js";
