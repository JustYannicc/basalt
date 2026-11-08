import type { Bytes } from "../types.js";

export interface BucketObject {
  size: number;
  body: ReadableStream<Bytes>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface Bucket {
  put(key: string, value: Bytes | string): Promise<unknown>;
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<BucketObject | null>;
  list(options: {
    prefix: string;
    cursor?: string;
    startAfter?: string;
    limit: number;
  }): Promise<{ objects: readonly { key: string }[]; truncated: boolean; cursor?: string }>;
}

export function storagePrefix(prefix: string) {
  if (!/^[A-Za-z0-9_-]{1,100}\/$/.test(prefix))
    throw new Error("Storage prefix must be one opaque drive id followed by a slash");
  return prefix;
}

export async function readRecord(
  bucket: Bucket,
  key: string,
  maxBytes = 512 * 1024,
): Promise<unknown> {
  const object = await bucket.get(key);
  if (!object || object.size > maxBytes)
    throw new Error("Durable record is missing or exceeds its byte limit");
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new Error("Durable record exceeds its byte limit");
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return value;
}

export async function* records(bucket: Bucket, prefix: string, startAfter?: string) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, startAfter, limit: 500 });
    for (const object of page.objects) yield object.key;
    if (page.truncated && (!page.cursor || page.cursor === cursor))
      throw new Error("Object listing did not advance its cursor");
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
