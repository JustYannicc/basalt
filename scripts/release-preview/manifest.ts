import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { stageKey } from "./keys.ts";
import { subjectManifestAad, toSubject, type StageSubject } from "../preview/subject.ts";

const maxManifestBytes = 1024 * 1024;

// A PR envelope keeps its original `pullRequest` field; a rehearsal envelope names itself instead.
const subjectField = (subject: StageSubject) => (subject.kind === "pr" ? "pullRequest" : "rehearsal");

function manifestCipherKey(key: string, subject: StageSubject): Buffer {
  return Buffer.from(stageKey(key, subject, "manifest"), "hex");
}

/** Cleanup artifacts can be public-repo artifacts: their resource manifest stays encrypted. */
export function sealManifest(contents: Buffer, key: string, owner: number | StageSubject): Buffer {
  const subject = toSubject(owner);
  if (contents.length > maxManifestBytes) throw new Error("Preview cleanup manifest is too large");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", manifestCipherKey(key, subject), iv);
  cipher.setAAD(Buffer.from(subjectManifestAad(subject)));
  const ciphertext = Buffer.concat([cipher.update(contents), cipher.final()]);
  return Buffer.from(JSON.stringify({ version: 1, [subjectField(subject)]: subject.number, iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }));
}

export function openManifest(envelope: Buffer, key: string, owner: number | StageSubject): Buffer {
  try {
    const subject = toSubject(owner);
    const field = subjectField(subject);
    if (envelope.length > 2 * maxManifestBytes) throw new Error();
    const value = JSON.parse(envelope.toString("utf8"));
    if (value.version !== 1 || value[field] !== subject.number
      || Object.keys(value).sort().join() !== ["version", field, "iv", "tag", "ciphertext"].sort().join()
      || typeof value.iv !== "string" || typeof value.tag !== "string" || typeof value.ciphertext !== "string") {
      throw new Error();
    }
    const iv = Buffer.from(value.iv, "base64"), tag = Buffer.from(value.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", manifestCipherKey(key, subject), iv);
    decipher.setAAD(Buffer.from(subjectManifestAad(subject)));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]);
    if (plaintext.length > maxManifestBytes) throw new Error();
    return plaintext;
  } catch { throw new Error("Preview cleanup manifest authentication failed"); }
}
