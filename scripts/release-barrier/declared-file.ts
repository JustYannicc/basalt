import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema, SchemaIssue } from "effect";
import { decodeDeclaredChanges, type DeclaredChanges } from "./declared-change-schema.ts";
import { BarrierRefusal } from "./manifest.ts";
import { publicPropPath } from "./prop-diff.ts";

const file = "release-declarations.json";
const paths = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: () => "invalid",
  checkHook: () => "invalid",
});

export async function loadDeclaredChanges(root: string): Promise<DeclaredChanges | undefined> {
  try {
    const metadata = await lstat(join(root, file));
    if (!metadata.isFile() || metadata.size > 65_536) throw new Error("Invalid declaration file");
    return decodeDeclaredChanges(JSON.parse(await readFile(join(root, file), "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    const changed = Schema.isSchemaError(error)
      ? paths(error.issue).issues.map((issue) => ({
          path: publicPropPath(
            (issue.path ?? []).map((part) => String(typeof part === "object" ? part.key : part)),
          ),
          changed: true as const,
        }))
      : [{ path: "$file", changed: true as const }];
    throw new BarrierRefusal("invalid-declaration-file", file, {
      fqn: file,
      type: "Alchemy.DeclaredChanges",
      changed,
      why: [
        "The fixed repository declaration must match schemaVersion 1 and contain only logical intent.",
      ],
    });
  }
}
