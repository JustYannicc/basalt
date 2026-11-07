import { mutation, number, object, string, type QueryContext } from "apps";
import { never } from "apps/operations/approval";
import { control } from "./control.ts";
import type { UsageImportResult } from "./import-contract.ts";
import { requirements } from "./requirements.ts";

/** The pool verifies management access and binds each apply to its dry-run approval. */
export const importUsage = mutation(
  {
    description:
      "Preview or import a bounded usage metadata page into this pool. Managers only. Preview every page before asking the person to import; apply only their approved content with the matching dry-run approval. Imported history stays unattributed and unpriced. Never read a provider's usage queue.",
    approval: never(),
    input: object({
      format: string(),
      data: string(),
      offset: number().optional(),
      mode: string(),
      approval: string().optional(),
    }),
  },
  async (ctx: QueryContext<typeof requirements>, input) =>
    control<UsageImportResult>(ctx, "/usage/import/self", { method: "POST", body: input }),
);
