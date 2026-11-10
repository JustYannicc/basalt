import { Bucket } from "alchemy/Cloudflare/R2";
import { retain } from "alchemy/RemovalPolicy";

const id = "VaultAttachments";

/**
 * Vault text and history live in Artifacts; this bucket holds only the content-addressed bytes
 * that a vault's Git tree points to. Objects are immutable and never deleted, so every version a
 * pointer ever named stays restorable.
 */
export const provisionVaultAttachments = Bucket(id, {
  jurisdiction: "eu",
  storageClass: "Standard",
  publicAccess: false,
  forceDestroy: false,
  domains: [],
  cors: [],
  lifecycleRules: [],
}).pipe(retain());

// Consumers bind provisionVaultAttachments itself. A reference resolves only from recorded state,
// so it fails stack evaluation until a release has recorded the bucket.
