import {
  mutation,
  query,
  object,
  array,
  string,
  number,
  boolean,
  jsonSchema,
  type MutationContext,
  type QueryContext,
} from "apps";
import { always } from "apps/operations/approval";
type Read = QueryContext<{ drive: true }>;
type Write = MutationContext<{ drive: true }>;
const identity = object({ id: string() });
export const importTools = {
  importStatus: query(
    {
      description:
        "Read the vault's counted initial import, including confirmed files, removed source files and its separate operation allowance.",
      input: object({ id: string().optional() }),
    },
    (ctx: Read, input) => ctx.drive.importStatus(input.id === undefined ? {} : { id: input.id }),
  ),
  planImport: mutation(
    {
      description:
        "Declare up to 100 initial source files per stable page before uploading. The final page reserves a counted one-time allowance. Later final pages may amend unclaimed files or record removed source paths; prior pages remain immutable.",
      approval: always(),
      input: object({
        id: string(),
        page: number(),
        entries: array(object({ path: string(), kind: string(), bytes: number(), hash: string() })),
        removed: array(string()).optional(),
        final: boolean(),
      }),
    },
    (ctx: Write, input) =>
      ctx.drive.planImport({
        ...input,
        entries: input.entries.map((entry) => {
          if (entry.kind !== "note" && entry.kind !== "attachment")
            throw new TypeError("Invalid initial import file kind");
          return { ...entry, kind: entry.kind };
        }),
        ...(input.removed === undefined ? {} : { removed: input.removed }),
      }),
  ),
  importRequest: mutation(
    {
      description:
        "Run a manifest-bound initial import request using its reserved allowance. Only import uploads and reconciliation reads are accepted. Every retry and storage operation is counted.",
      approval: always(),
      input: object({ id: string(), request: jsonSchema({ type: "object" }) }),
    },
    (ctx: Write, input) => {
      if (
        input.request === null ||
        typeof input.request !== "object" ||
        Array.isArray(input.request)
      )
        throw new TypeError("Invalid initial import request");
      return ctx.drive.runImport({
        id: input.id,
        request: Object.fromEntries(Object.entries(input.request)),
      });
    },
  ),
  finishImport: mutation(
    {
      description:
        "Close the one-time allowance after every declared file has a confirmed saved version or an explicit removed-source record. Unspent credit is released; counted usage and files are retained.",
      approval: always(),
      input: identity,
    },
    (ctx: Write, input) => ctx.drive.finishImport(input),
  ),
};
