import { attachmentTools } from "./attachments.ts";
import { importTools } from "./imports.ts";
import { changeTools } from "./changes.ts";
import {
  array,
  defineApp,
  jsonSchema,
  mutation,
  number,
  object,
  query,
  router,
  string,
  type MutationContext,
  type QueryContext,
} from "apps";
import { always } from "apps/operations/approval";

export const requirements = { drive: true } as const;
type Read = QueryContext<typeof requirements>;
type Write = MutationContext<typeof requirements>;
const listCursor = object({ at: string(), path: string(), after: string() });
const searchCursor = object({
  at: string(),
  query: string(),
  frames: array(object({ path: string(), after: string() })),
  pending: object({ path: string(), offset: number(), line: number(), tail: string() }).optional(),
});
const file = object({
  path: string(),
  at: string().optional(),
  offset: number().optional(),
  maxBytes: number().optional(),
});
const readInput = (input: {
  path: string;
  at?: string | undefined;
  offset?: number | undefined;
  maxBytes?: number | undefined;
}) => ({
  path: input.path,
  ...(input.at === undefined ? {} : { at: input.at }),
  ...(input.offset === undefined ? {} : { offset: input.offset }),
  ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
});
const write = object({ base: string(), path: string(), content: string(), operation: string() });
const applyNotes = mutation(
  {
    description:
      "Apply 1 to 100 text changes atomically against one exact cloud revision. Reuse the operation id after an unknown reply.",
    approval: always(),
    input: object({
      base: string(),
      operation: string(),
      edits: array(object({ path: string(), content: jsonSchema({ type: ["string", "null"] }) })),
    }),
  },
  (ctx: Write, input) =>
    ctx.drive.apply({
      ...input,
      edits: input.edits.map((edit) => {
        if (edit.content !== null && typeof edit.content !== "string")
          throw new TypeError("Batch content must be text or null");
        return { ...edit, content: edit.content };
      }),
    }),
);
export const listNotes = query(
  {
    description:
      "List this vault's cloud notes and folders at one pinned version. Pass the returned next cursor to continue. Devices may be off.",
    input: object({
      path: string().optional(),
      at: string().optional(),
      cursor: listCursor.optional(),
      limit: number().optional(),
    }),
  },
  (ctx: Read, input) =>
    ctx.drive.list({
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.at === undefined ? {} : { at: input.at }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    }),
);
export const readNote = query(
  {
    description:
      "Read up to 256 KiB of a cloud note. Continue with offset=next and the same at; null next means complete.",
    input: file,
  },
  (ctx: Read, input) => ctx.drive.read(readInput(input)),
);
export const searchNotes = query(
  {
    description:
      "Search the complete cloud vault. Follow cursor until complete is true; each page has a bounded scan budget.",
    input: object({
      query: string(),
      at: string().optional(),
      cursor: searchCursor.optional(),
      limit: number().optional(),
      maxFiles: number().optional(),
    }),
  },
  (ctx: Read, input) =>
    ctx.drive.search({
      query: input.query,
      ...(input.at === undefined ? {} : { at: input.at }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.maxFiles === undefined ? {} : { maxFiles: input.maxFiles }),
    }),
);
export const readAttachment = query(
  {
    description:
      "Read up to 64 KiB of a cloud attachment as base64. Continue with offset=next and the same at; null next means complete.",
    input: file,
  },
  (ctx: Read, input) => ctx.drive.attachment(readInput(input)),
);
const operationStatus = query(
  {
    description:
      "Recover a saved, landed or conflicting operation after an unknown reply. Reuse the original operation id.",
    input: object({ operation: string() }),
  },
  (ctx: Read, input) => ctx.drive.receipt(input),
);
const resolveConflict = mutation(
  {
    description:
      "Save reviewed conflict choices with both Git parents. Exact main and writer heads must still match. Null content deletes that path.",
    approval: always(),
    input: object({
      ref: string(),
      expected: string(),
      main: string(),
      edits: array(object({ path: string(), content: jsonSchema({ type: ["string", "null"] }) })),
      operation: string(),
    }),
  },
  (ctx: Write, input) =>
    ctx.drive.resolve({
      ...input,
      edits: input.edits.map((edit) => {
        if (edit.content !== null && typeof edit.content !== "string")
          throw new TypeError("Conflict content must be text or null");
        return { ...edit, content: edit.content };
      }),
    }),
);
export const history = query(
  {
    description: "Read retained cloud versions and both parents of merged edits.",
    input: object({ at: string().optional(), limit: number().optional() }),
  },
  (ctx: Read, input) =>
    ctx.drive.history({
      ...(input.at === undefined ? {} : { at: input.at }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    }),
);
const createNote = mutation(
  {
    description:
      "Create a cloud note without replacing an existing path. Supply the base from list/read and reuse operation unchanged on retry. Conflicts preserve the saved branch.",
    approval: always(),
    input: write,
  },
  (ctx: Write, input) => ctx.drive.write({ ...input, mode: "create" }),
);
const editNote = mutation(
  {
    description:
      "Edit an existing note from its read base. Git combines clean concurrent edits and preserves conflicts for review.",
    approval: always(),
    input: write,
  },
  (ctx: Write, input) => ctx.drive.write({ ...input, mode: "edit" }),
);
const moveNote = mutation(
  {
    description:
      "Move a cloud note while refusing an existing destination. Its old versions remain in history.",
    approval: always(),
    input: object({ base: string(), from: string(), to: string(), operation: string() }),
  },
  (ctx: Write, input) => ctx.drive.move(input),
);
const deleteNote = mutation(
  {
    description: "Remove a note from the current vault while retaining its history.",
    approval: always(),
    input: object({ base: string(), path: string(), operation: string() }),
  },
  (ctx: Write, input) => ctx.drive.remove(input),
);
const restoreVersion = mutation(
  {
    description:
      "Restore a historical note as a new edit at base. This preserves intervening history.",
    approval: always(),
    input: object({ base: string(), from: string(), path: string(), operation: string() }),
  },
  (ctx: Write, input) => ctx.drive.restore(input),
);
export default defineApp(requirements, {
  tools: router({
    ...changeTools,
    ...importTools,
    ...attachmentTools,
    applyNotes,
    listNotes,
    readNote,
    readAttachment,
    operationStatus,
    resolveConflict,
    searchNotes,
    history,
    createNote,
    editNote,
    moveNote,
    deleteNote,
    restoreVersion,
  }),
});
