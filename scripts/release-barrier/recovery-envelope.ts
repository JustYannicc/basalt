import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { Schema } from "effect";
import { BarrierRefusal } from "./manifest.ts";

const maximumBytes = 1024 * 1024;
const envelope = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  candidate: Schema.String,
  manifest: Schema.String,
  iv: Schema.String,
  tag: Schema.String,
  ciphertext: Schema.String,
});
function keyFor(key: string, candidate: string) {
  if (!/^[a-f0-9]{64}$/i.test(key) || !/^[a-f0-9]{40}$/.test(candidate))
    throw new BarrierRefusal("container-recovery-key-invalid");
  return hkdfSync(
    "sha256",
    Buffer.from(key, "hex"),
    Buffer.from(candidate),
    "basalt-container-recovery-v1",
    32,
  );
}

/** Public CI artifacts retain only authenticated ciphertext; the key is the existing deployment encryption secret. */
export function sealRecovery(value: unknown, key: string, candidate: string, manifest: string) {
  const plaintext = Buffer.from(JSON.stringify(value));
  if (plaintext.length > maximumBytes)
    throw new BarrierRefusal("container-recovery-manifest-too-large");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(key, candidate), iv);
  cipher.setAAD(Buffer.from(`${candidate}:${manifest}`));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    schemaVersion: 1,
    candidate,
    manifest,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function openRecovery(
  value: unknown,
  key: string,
  candidate: string,
  manifest: string,
): unknown {
  try {
    const sealed = Schema.decodeUnknownSync(envelope, { onExcessProperty: "error" })(value);
    if (
      sealed.candidate !== candidate ||
      sealed.manifest !== manifest ||
      sealed.ciphertext.length > 2 * maximumBytes
    )
      throw new Error();
    const iv = Buffer.from(sealed.iv, "base64"),
      tag = Buffer.from(sealed.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", keyFor(key, candidate), iv);
    decipher.setAAD(Buffer.from(`${candidate}:${manifest}`));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]);
    if (plaintext.length > maximumBytes) throw new Error();
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new BarrierRefusal("container-recovery-manifest-authentication-failed");
  }
}
