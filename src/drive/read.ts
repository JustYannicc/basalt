import {
  DriveError,
  decodeAttachmentPointer,
  type Drive,
  type openAttachmentStore,
} from "./shared/index.ts";
export interface ReadInput {
  path: string;
  at?: string;
  offset?: number;
  maxBytes?: number;
}
export function createReader(drive: Drive, attachments?: ReturnType<typeof openAttachmentStore>) {
  const fileAt = async (input: { path: string; at?: string }) => {
    const { at } = await drive.list(
      input.at === undefined ? { limit: 1 } : { at: input.at, limit: 1 },
    );
    const file = await drive.read({ path: input.path, at });
    if (!file) return null;
    const pointer = decodeAttachmentPointer(file.content);
    return {
      at,
      path: input.path,
      blob: file.blob,
      bytes: pointer?.bytes ?? file.content.length,
      pointer,
      data: file.content,
    };
  };
  const load = async (input: ReadInput, maximum: number, minimum: number) => {
    const offset = input.offset ?? 0,
      maxBytes = input.maxBytes ?? Math.min(maximum, 65536);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < minimum ||
      maxBytes > maximum
    )
      throw new DriveError("invalid", "Read offset or byte bound is invalid");
    const file = await fileAt(input);
    if (!file) return null;
    if (offset > file.bytes) throw new DriveError("invalid", "Read offset exceeds the file length");
    return { ...file, offset, end: Math.min(offset + maxBytes, file.bytes) };
  };
  const byteRange = async (input: ReadInput, maximum: number) => {
    const file = await load({ ...input }, maximum, 1);
    if (!file) return null;
    const { pointer, data, end, ...metadata } = file;
    let content: Uint8Array<ArrayBuffer>;
    if (pointer) {
      if (!attachments) throw new DriveError("missing", "Attachment storage is not configured");
      const ready = await attachments.head({ oid: pointer.oid });
      if (!ready || ready.bytes !== pointer.bytes)
        throw new DriveError("integrity", "Attachment canonical bytes are missing or mismatched");
      content = (
        await attachments.read({
          oid: pointer.oid,
          offset: file.offset,
          length: input.maxBytes ?? Math.min(maximum, 65536),
        })
      ).content;
    } else content = data.slice(file.offset, end);
    return { ...metadata, content, next: end === file.bytes ? null : end };
  };
  return {
    async info(input: { path: string; at?: string }) {
      const file = await fileAt(input);
      if (!file) return null;
      const { pointer, data: _data, ...metadata } = file;
      return { ...metadata, attachment: pointer };
    },
    async read(input: ReadInput) {
      const file = await load({ ...input }, 262144, 4);
      if (!file) return null;
      const { pointer, data: inline, end: requestedEnd, ...metadata } = file;
      if (pointer && !input.path.toLowerCase().endsWith(".md"))
        throw new DriveError("invalid", "This file is binary; use attachment download");
      const data = pointer
        ? (await byteRange({ ...input, maxBytes: requestedEnd - file.offset + 3 }, 262147))!.content
        : inline;
      const start = pointer ? 0 : file.offset;
      if (data.includes(0) || (start < data.length && (data[start]! & 0xc0) === 0x80))
        throw new DriveError(
          "invalid",
          "Binary file or invalid UTF-8 offset; use attachment download",
        );
      let end = pointer ? Math.min(requestedEnd - file.offset, data.length) : requestedEnd;
      while (end < data.length && (data[end]! & 0xc0) === 0x80) end--;
      let content;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(start, end));
      } catch {
        throw new DriveError("invalid", "This file is binary; use attachment download");
      }
      const next = pointer ? file.offset + end : end;
      return { ...metadata, content, next: next === file.bytes ? null : next };
    },
    bytes: (input: ReadInput) => byteRange(input, 1048576),
    async attachment(input: ReadInput) {
      const file = await byteRange(input, 65536);
      if (!file) return null;
      const { content, ...metadata } = file;
      let raw = "";
      for (const byte of content) raw += String.fromCharCode(byte);
      return { ...metadata, contentBase64: btoa(raw) };
    },
  };
}
