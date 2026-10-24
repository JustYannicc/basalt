import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { previewKey } from "./keys.ts";

const maxManifestBytes = 1024 * 1024;

/** Cleanup artifacts can be public-repo artifacts: their resource manifest stays encrypted. */
export function sealManifest(contents: Buffer, key: string, pullRequest: number): Buffer {
  if (contents.length > maxManifestBytes) throw new Error("Preview cleanup manifest is too large");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(previewKey(key, pullRequest, "manifest"), "hex"), iv);
  cipher.setAAD(Buffer.from(`basalt-preview-manifest-v1:${pullRequest}`));
  const ciphertext = Buffer.concat([cipher.update(contents), cipher.final()]);
  return Buffer.from(JSON.stringify({ version: 1, pullRequest, iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }));
}

export function openManifest(envelope: Buffer, key: string, pullRequest: number): Buffer {
  try {
    if (envelope.length > 2 * maxManifestBytes) throw new Error();
    const value = JSON.parse(envelope.toString("utf8"));
    if (value.version !== 1 || value.pullRequest !== pullRequest
      || Object.keys(value).sort().join() !== ["version", "pullRequest", "iv", "tag", "ciphertext"].sort().join()
      || typeof value.iv !== "string" || typeof value.tag !== "string" || typeof value.ciphertext !== "string") {
      throw new Error();
    }
    const iv = Buffer.from(value.iv, "base64"), tag = Buffer.from(value.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(previewKey(key, pullRequest, "manifest"), "hex"), iv);
    decipher.setAAD(Buffer.from(`basalt-preview-manifest-v1:${pullRequest}`));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]);
    if (plaintext.length > maxManifestBytes) throw new Error();
    return plaintext;
  } catch { throw new Error("Preview cleanup manifest authentication failed"); }
}
