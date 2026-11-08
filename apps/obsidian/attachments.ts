import {
  mutation,
  query,
  object,
  string,
  number,
  type MutationContext,
  type QueryContext,
} from "apps";
import { always } from "apps/operations/approval";
type Read = QueryContext<{ drive: true }>;
type Write = MutationContext<{ drive: true }>;
const uploadInput = object({ upload: string(), cursor: number().optional() });
const continuation = (input: { upload: string; cursor?: number | undefined }) => ({
  upload: input.upload,
  ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
});
export const attachmentTools = {
  fileInfo: query(
    {
      description: "Read a file's size and retained attachment identity at one pinned revision.",
      input: object({ path: string(), at: string().optional() }),
    },
    (ctx: Read, input) =>
      ctx.drive.info({ path: input.path, ...(input.at === undefined ? {} : { at: input.at }) }),
  ),
  beginAttachment: mutation(
    {
      description:
        "Reserve and resume an immutable attachment upload. Send only the missing one MiB parts. Follow next with cursor to list further missing parts.",
      approval: always(),
      input: object({
        operation: string(),
        oid: string(),
        bytes: number(),
        cursor: number().optional(),
      }),
    },
    (ctx: Write, input) =>
      ctx.drive.beginAttachment({
        operation: input.operation,
        oid: input.oid,
        bytes: input.bytes,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      }),
  ),
  uploadAttachmentPart: mutation(
    {
      description:
        "Store one exact attachment part. Repeating it after a lost reply never uploads different bytes.",
      approval: always(),
      input: object({ upload: string(), part: number(), contentBase64: string() }),
    },
    (ctx: Write, input) => ctx.drive.uploadAttachmentPart(input),
  ),
  completeAttachment: mutation(
    {
      description:
        "Verify up to sixteen MiB of an upload. Follow next with cursor until present. Only a complete SHA-256 match can be attached to a path.",
      approval: always(),
      input: uploadInput,
    },
    (ctx: Write, input) => ctx.drive.completeAttachment(continuation(input)),
  ),
  cancelAttachment: mutation(
    {
      description:
        "Cancel an unaccepted upload and reclaim a bounded page of parts. Follow next until null. Accepted bytes are never deleted.",
      approval: always(),
      input: uploadInput,
    },
    (ctx: Write, input) => ctx.drive.cancelAttachment(continuation(input)),
  ),
  attachFile: mutation(
    {
      description:
        "Save a verified attachment at a vault path against an exact Git base. Concurrent edits keep both versions for review.",
      approval: always(),
      input: object({
        base: string(),
        path: string(),
        operation: string(),
        oid: string(),
        bytes: number(),
      }),
    },
    (ctx: Write, input) => ctx.drive.attach(input),
  ),
};
