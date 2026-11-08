import { createCipheriv, createHash } from "node:crypto";

export const corpusSeed = "obsidian-volume-v1-2026-11-07";
export const searchNeedle = "COLD_CORPUS_NEEDLE_20261107";
export const notePath = (index: number) =>
  `notes/${String(Math.floor(index / 100)).padStart(3, "0")}/note-${String(index).padStart(5, "0")}.md`;
export function noteContent(index: number, version: number, total: number) {
  const key = createHash("sha256").update(`${corpusSeed}:${index}:${version}`).digest();
  const cipher = createCipheriv("aes-256-ctr", key, Buffer.alloc(16));
  const text = cipher.update(Buffer.alloc(38_000)).toString("base64url");
  const header = `# Synthetic note ${index}, revision ${version}\n\n${index === total - 1 ? searchNeedle : "Deterministic high-entropy volume fixture"}\n\n`;
  return (header + text).slice(0, 50_000);
}
export const blobId = (content: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest("hex");
