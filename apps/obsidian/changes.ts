import { query, object, array, string, number, jsonSchema, type QueryContext } from "apps";
type Read = QueryContext<{ drive: true }>;
export const changeTools = {
  changes: query(
    {
      description:
        "Read only file changes between pinned cloud versions. Start from null for first download, then follow next until null.",
      input: object({
        from: jsonSchema({ type: ["string", "null"] }),
        to: string(),
        cursor: object({
          from: jsonSchema({ type: ["string", "null"] }),
          to: string(),
          frames: array(object({ name: string(), after: string() })),
        }).optional(),
        limit: number().optional(),
      }),
    },
    (ctx: Read, input) => {
      const from = input.from;
      if (from !== null && typeof from !== "string")
        throw new TypeError("Expected a revision or null");
      const cursor = input.cursor;
      let continuation;
      if (cursor) {
        const from = cursor.from;
        if (from !== null && typeof from !== "string")
          throw new TypeError("Expected a cursor revision or null");
        continuation = { ...cursor, from };
      }
      return ctx.drive.changes({
        from,
        to: input.to,
        ...(continuation ? { cursor: continuation } : {}),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
    },
  ),
};
