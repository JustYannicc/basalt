import { createSearch } from "./search.ts";
import { createReader } from "./read.ts";
import {
  DriveError,
  encodeAttachmentPointer,
  type openAttachmentStore,
  type createChangeReader,
  type Drive,
  type Edit,
} from "./shared/index.ts";

export interface WriteInput {
  base: string;
  path: string;
  content: string;
  operation: string;
  mode: "create" | "edit";
}
const operationKey = async (operation: string) => {
  if (!operation || operation.length > 128)
    throw new DriveError("invalid", "An operation id must contain 1 to 128 characters");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(operation));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** The host supplies one already-authorized drive; tools cannot choose an app, bucket or owner. */
export function createDriveService(
  drive: Drive,
  attachments?: ReturnType<typeof openAttachmentStore>,
  changes?: ReturnType<typeof createChangeReader>,
  importBase?: string,
) {
  const save = async (
    input: { base: string; operation: string },
    edits: readonly Edit[],
    message: string,
  ) => {
    input = { ...input };
    edits = edits.map((edit) => ({
      ...edit,
      content: edit.content instanceof Uint8Array ? edit.content.slice() : edit.content,
    }));
    const key = await operationKey(input.operation);
    const writer = await drive.openWriter({
      id: `operation-${key}`,
      base: input.base,
      operation: `open:${key}`,
    });
    const saved = await drive.commit({
      ref: writer.ref,
      expected: writer.oid,
      edits,
      message,
      operation: `save:${key}`,
    });
    return drive.land({ ref: writer.ref, expected: saved.oid, operation: `land:${key}` });
  };
  return {
    ...createReader(drive, attachments),
    changes: (input: Parameters<ReturnType<typeof createChangeReader>>[0]) => {
      if (!changes) throw new DriveError("invalid", "Pinned change reads are not configured");
      return changes(input);
    },
    async attach(input: {
      base: string;
      path: string;
      operation: string;
      oid: string;
      bytes: number;
    }) {
      const ready = await attachments?.head({ oid: input.oid });
      if (!ready || ready.bytes !== input.bytes)
        throw new DriveError("missing", "Attachment bytes are missing or have a different length");
      return save(
        input,
        [
          {
            path: input.path,
            content: input.bytes === 0 ? new Uint8Array() : encodeAttachmentPointer(input),
          },
        ],
        `Attach ${input.path}`,
      );
    },
    search: createSearch(drive, attachments),
    apply: (input: { base: string; operation: string; edits: readonly Edit[] }) =>
      save(input, input.edits, "Apply cloud file batch"),
    async receipt(input: { operation: string }) {
      const key = await operationKey(input.operation);
      for (const stage of ["land", "resolve", "save", "open"]) {
        const receipt = await drive.receipt(`${stage}:${key}`);
        if (receipt) return receipt;
      }
      return null;
    },
    async resolve(input: {
      ref: string;
      expected: string;
      main: string;
      edits: readonly { path: string; content: string | null }[];
      operation: string;
    }) {
      input = { ...input, edits: input.edits.map((edit) => ({ ...edit })) };
      const key = await operationKey(input.operation);
      const saved = await drive.resolve({
        ...input,
        operation: `resolve:${key}`,
        message: "Resolve cloud file conflict",
      });
      return drive.land({ ref: input.ref, expected: saved.oid, operation: `land:${key}` });
    },
    history: (input: Parameters<Drive["history"]>[0] = {}) => drive.history(input),
    async move(input: { base: string; from: string; to: string; operation: string }) {
      input = { ...input };
      const source = await drive.read({ at: input.base, path: input.from });
      if (!source)
        throw new DriveError("missing", "The source file does not exist at the chosen base");
      if (await drive.read({ at: input.base, path: input.to }))
        throw new DriveError("stale", "The destination already exists at the chosen base");
      return save(
        input,
        [
          { path: input.from, content: null },
          { path: input.to, content: source.content },
        ],
        `Move ${input.from} to ${input.to}`,
      );
    },
    async remove(input: { base: string; path: string; operation: string }) {
      input = { ...input };
      if (!(await drive.read({ at: input.base, path: input.path })))
        throw new DriveError("missing", "The file does not exist at the chosen base");
      return save(input, [{ path: input.path, content: null }], `Delete ${input.path}`);
    },
    async restore(input: { base: string; from: string; path: string; operation: string }) {
      input = { ...input };
      const file = await drive.read({ at: input.from, path: input.path });
      if (!file)
        throw new DriveError("missing", "The historical file does not exist at that version");
      return save(
        input,
        [{ path: input.path, content: file.content }],
        `Restore ${input.path} from ${input.from}`,
      );
    },
    list: async (input: Parameters<Drive["list"]>[0] = {}) => ({
      ...(await drive.list(input)),
      ...(importBase ? { importBase } : {}),
    }),
    async write(input: WriteInput) {
      input = { ...input };
      const existing = await drive.read({ path: input.path, at: input.base });
      if (input.mode === "create" && existing)
        throw new DriveError("stale", "The path already exists at the chosen base");
      if (input.mode === "edit" && !existing)
        throw new DriveError("missing", "The note does not exist at the chosen base");
      return save(input, [{ path: input.path, content: input.content }], `Write ${input.path}`);
    },
  };
}
