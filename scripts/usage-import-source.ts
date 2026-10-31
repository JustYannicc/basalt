import { readFile, stat } from "node:fs/promises";
import { maximumImportBytes } from "../src/pool/model-history/import.ts";
import { historyObject } from "../src/pool/model-history/record.ts";

export async function privateCredential(path: string): Promise<string> {
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0 || info.size > 16_384) throw new Error("Credential file must be private and bounded");
  const value = (await readFile(path, "utf8")).trim();
  if (!value || /[\r\n]/.test(value)) throw new Error("Invalid credential file");
  return value;
}

export function serviceOrigin(value: string): URL {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !["", "/"].includes(url.pathname)) throw new Error("Supply a service origin without credentials or a path");
  return url;
}

async function responseText(response: Response): Promise<string> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Usage export failed with HTTP ${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing usage export body");
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maximumImportBytes) { await reader.cancel(); throw new Error("Usage export page is too large"); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Fixed non-destructive routes only. Home supports offset with its 10,000-row export limit. */
export async function* homeExportPages(input: {
  origin: URL; managementKey: string; from: string; to: string;
}): AsyncGenerator<string> {
  const params = new URLSearchParams({ from: input.from, to: input.to, sort: "timestamp_asc", limit: "200", format: "jsonl" });
  const headers = { "X-Management-Key": input.managementKey };
  const total = async () => {
    const countParams = new URLSearchParams(params);
    countParams.set("limit", "1");
    const response = await globalThis.fetch(new URL(`/v8/management/usage/records?${countParams}`, input.origin),
      { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
    const value = historyObject(JSON.parse(await responseText(response)));
    if (typeof value.total !== "number" || !Number.isSafeInteger(value.total) || value.total < 0)
      throw new Error("The source does not expose Home per-request records");
    return value.total;
  };
  const expected = await total();
  let read = 0;
  while (read < expected) {
    params.set("offset", String(read));
    const response = await globalThis.fetch(new URL(`/v8/management/usage/export?${params}`, input.origin),
      { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
    const data = await responseText(response);
    const count = data.split(/\r?\n/).filter((line) => line.trim()).length;
    if (count === 0 || count > 200 || read + count > expected) throw new Error("Source export changed while paging");
    read += count;
    yield data;
  }
  if (await total() !== expected) throw new Error("Source export changed; repeat the non-destructive dry run");
}

export async function exportFile(path: string): Promise<string> {
  if ((await stat(path)).size > maximumImportBytes) throw new Error("Usage export file exceeds the bounded upload size");
  return readFile(path, "utf8");
}
