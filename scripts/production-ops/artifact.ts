import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { canonical, hash } from "./encoding.ts";
import { mergeInventoryPages } from "./inventory-merge.ts";
export { canonical, hash } from "./encoding.ts";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function createRecipient(path: string): string {
  const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
  mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  writeFileSync(path, pair.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
    flag: "wx",
  });
  return pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

/** Only a private local file receives the decrypted inventory or recovery snapshot. */
export function decryptArtifact(artifact: unknown, key: string, target: string): string {
  if (record(artifact) && artifact.format === "basalt-production-inventory-pages-v1") {
    if (
      !Array.isArray(artifact.pages) ||
      artifact.pages.length < 1 ||
      artifact.pages.length > 2000 ||
      artifact.sha256 !== hash(canonical(artifact.pages))
    )
      throw new Error("Invalid paged artifact");
    const pages = artifact.pages.map(
      (page: unknown) => JSON.parse(decryptArtifact(page, key, target)) as unknown,
    );
    const digests = artifact.pages.map((page: unknown) => {
      if (!record(page) || typeof page.sha256 !== "string") throw new Error("Invalid page digest");
      return page.sha256;
    });
    return canonical(mergeInventoryPages(pages, digests)) + "\n";
  }
  if (!record(artifact) || typeof artifact.sha256 !== "string" || !record(artifact.recipient))
    throw new Error("Invalid artifact");
  const copy = artifact.recipient;
  if (
    copy.version !== 1 ||
    ![copy.wrappedKey, copy.iv, copy.ciphertext].every((value) => typeof value === "string")
  )
    throw new Error("Invalid artifact");
  const rawKey = privateDecrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(String(copy.wrappedKey), "base64"),
  );
  const encrypted = Buffer.from(String(copy.ciphertext), "base64");
  const decipher = createDecipheriv("aes-256-gcm", rawKey, Buffer.from(String(copy.iv), "base64"));
  decipher.setAAD(Buffer.from(`basalt-production-ops-v1:${target}`));
  decipher.setAuthTag(encrypted.subarray(-16));
  const plaintext = Buffer.concat([
    decipher.update(encrypted.subarray(0, -16)),
    decipher.final(),
  ]).toString("utf8");
  if (hash(plaintext) !== artifact.sha256) throw new Error("Artifact checksum differs");
  return plaintext;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, file, keyFile, target, output] = process.argv.slice(2);
    if (command === "recipient" && file !== undefined)
      process.stdout.write(`${createRecipient(file)}\n`);
    else if (command === "decrypt" && file && keyFile && target && output) {
      const response: unknown = JSON.parse(readFileSync(file, "utf8"));
      const artifact = record(response) && "artifact" in response ? response.artifact : response;
      mkdirSync(dirname(resolve(output)), { recursive: true, mode: 0o700 });
      writeFileSync(output, decryptArtifact(artifact, readFileSync(keyFile, "utf8"), target), {
        mode: 0o600,
        flag: "wx",
      });
    } else throw new Error("Invalid command");
  } catch {
    process.stderr.write(
      "Production ops artifact command failed. Check the private paths, recipient and target.\n",
    );
    process.exitCode = 1;
  }
}
