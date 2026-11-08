import { DriveError, type Drive, type openAttachmentStore } from "./shared/index.ts";
import { createReader } from "./read.ts";

export interface SearchCursor {
  at: string;
  query: string;
  frames: readonly { path: string; after: string }[];
  pending?: { path: string; offset: number; line: number; tail: string };
}
export interface SearchInput {
  query: string;
  at?: string;
  cursor?: SearchCursor;
  limit?: number;
  maxFiles?: number;
}
const bounded = (value: number, max: number) =>
  Number.isSafeInteger(value) && value >= 1 && value <= max;
const newlines = (text: string) => text.split("\n").length - 1;

export function createSearch(drive: Drive, attachments?: ReturnType<typeof openAttachmentStore>) {
  const reader = createReader(drive, attachments);
  return async (input: SearchInput) => {
    input = structuredClone(input);
    const limit = input.limit ?? 20,
      maxFiles = input.maxFiles ?? 20;
    if (!input.query || input.query.length > 256 || !bounded(limit, 50) || !bounded(maxFiles, 50))
      throw new DriveError("invalid", "Search exceeds its query or work bound");
    const cursor = input.cursor;
    if (
      cursor &&
      (cursor.query !== input.query ||
        (input.at !== undefined && cursor.at !== input.at) ||
        cursor.frames.length > 32 ||
        JSON.stringify(cursor).length > 64 * 1024 ||
        (cursor.pending &&
          (!Number.isSafeInteger(cursor.pending.offset) ||
            cursor.pending.offset < 0 ||
            !Number.isSafeInteger(cursor.pending.line) ||
            cursor.pending.line < 1 ||
            cursor.pending.tail.length > 600)))
    )
      throw new DriveError("invalid", "Search cursor does not match the query or revision");
    const { at } = await drive.list({
      ...(input.at === undefined && cursor === undefined ? {} : { at: input.at ?? cursor!.at }),
      limit: 1,
    });
    const frames = cursor?.frames.map((frame) => ({ ...frame })) ?? [{ path: "", after: "" }];
    let pending = cursor?.pending && { ...cursor.pending };
    const matches: { path: string; blob: string; line: number; excerpt: string }[] = [],
      skippedBinary: string[] = [];
    let scanned = 0,
      visits = 0,
      readBytes = 0;
    // A single large note must not turn one search page into an unbounded object-store scan.
    while (
      (pending || frames.length) &&
      matches.length < limit &&
      readBytes < 1048576 &&
      visits < 100
    ) {
      if (!pending) {
        if (scanned >= maxFiles) break;
        const frame = frames.at(-1)!;
        const page = await drive.list({
          at,
          path: frame.path,
          limit: 1,
          ...(frame.after ? { cursor: { at, path: frame.path, after: frame.after } } : {}),
        });
        visits++;
        const entry = page.entries[0];
        if (!entry) {
          frames.pop();
          continue;
        }
        frame.after = entry.name;
        if (entry.kind === "directory") {
          frames.push({ path: entry.path, after: "" });
          continue;
        }
        scanned++;
        pending = { path: entry.path, offset: 0, line: 1, tail: "" };
      }
      let file;
      try {
        file = await reader.read({
          at,
          path: pending.path,
          offset: pending.offset,
          maxBytes: 65536,
        });
      } catch (error) {
        if (!(error instanceof DriveError) || error.code !== "invalid") throw error;
        skippedBinary.push(pending.path);
        pending = undefined;
        continue;
      }
      if (!file) throw new DriveError("integrity", "Pinned search file disappeared");
      readBytes += (file.next ?? file.bytes) - pending.offset;
      const content = pending.tail + file.content;
      const offset = content
        .toLocaleLowerCase("en-US")
        .indexOf(input.query.toLocaleLowerCase("en-US"));
      if (offset >= 0) {
        matches.push({
          path: pending.path,
          blob: file.blob,
          line: pending.line + newlines(content.slice(0, offset)),
          excerpt: content.slice(Math.max(0, offset - 80), offset + input.query.length + 160),
        });
        pending = undefined;
      } else if (file.next === null) pending = undefined;
      else {
        const retained = Math.min(content.length, input.query.length + 80),
          removed = content.slice(0, content.length - retained);
        pending = {
          path: pending.path,
          offset: file.next,
          line: pending.line + newlines(removed),
          tail: content.slice(-retained),
        };
      }
    }
    const complete = frames.length === 0 && !pending;
    return {
      at,
      matches,
      scanned,
      skippedBinary,
      complete,
      cursor: complete ? null : { at, query: input.query, frames, ...(pending ? { pending } : {}) },
    };
  };
}
