import createHash from "sha.js";
import { Buffer } from "buffer";
import { DriveError } from "./errors.js";

export interface Attachment {
  oid: string;
  bytes: number;
}
const version = "version https://git-lfs.github.com/spec/v1\n";
export function attachment(input: Attachment) {
  if (!/^[0-9a-f]{64}$/.test(input.oid) || !Number.isSafeInteger(input.bytes) || input.bytes < 0)
    throw new DriveError("invalid", "Invalid attachment hash or byte count");
  return input;
}
export function incrementalSha256(snapshot?: unknown) {
  const hash = createHash("sha256");
  const fields = ["_a", "_b", "_c", "_d", "_e", "_f", "_g", "_h"] as const;
  if (snapshot !== undefined) {
    if (
      !snapshot ||
      typeof snapshot !== "object" ||
      !("length" in snapshot) ||
      typeof snapshot.length !== "number" ||
      !Number.isSafeInteger(snapshot.length) ||
      snapshot.length < 0 ||
      snapshot.length % 64 !== 0 ||
      !("words" in snapshot) ||
      !Array.isArray(snapshot.words) ||
      snapshot.words.length !== 8
    )
      throw new DriveError("integrity", "Invalid SHA-256 checkpoint");
    hash._len = snapshot.length;
    for (const [index, field] of fields.entries()) {
      const word: unknown = snapshot.words[index];
      if (
        typeof word !== "number" ||
        !Number.isInteger(word) ||
        word < -2147483648 ||
        word > 4294967295
      )
        throw new DriveError("integrity", "Invalid SHA-256 checkpoint word");
      hash[field] = word;
    }
  }
  return {
    update(bytes: Uint8Array) {
      hash.update(Buffer.from(bytes));
    },
    // Pinned sha.js 2.4.12 state is persisted only on complete SHA-256 block boundaries.
    // This avoids rehashing earlier attachment parts after a Worker request ends.
    checkpoint() {
      if (hash._len % 64 !== 0)
        throw new DriveError("invalid", "SHA-256 checkpoint needs a complete block");
      return { length: hash._len, words: fields.map((field) => hash[field]) };
    },
    digest() {
      return hash.digest("hex");
    },
  };
}
export function sha256(bytes: Uint8Array) {
  const hash = incrementalSha256();
  hash.update(bytes);
  return hash.digest();
}
export function encodeAttachmentPointer(input: Attachment) {
  attachment(input);
  if (input.bytes === 0) throw new DriveError("invalid", "Empty files use an empty Git blob");
  return new TextEncoder().encode(`${version}oid sha256:${input.oid}\nsize ${input.bytes}\n`);
}
export function decodeAttachmentPointer(content: Uint8Array): Attachment | null {
  if (content.length >= 1024) return null;
  const text = new TextDecoder().decode(content);
  if (!text.startsWith(version)) return null;
  const match = /^oid sha256:([0-9a-f]{64})\nsize ([1-9][0-9]*)\n$/.exec(
    text.slice(version.length),
  );
  if (!match) return null;
  const bytes = Number(match[2]);
  return Number.isSafeInteger(bytes) ? { oid: match[1]!, bytes } : null;
}
