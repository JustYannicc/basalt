import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { filesBelow } from "./source.ts";
import { containerInputs } from "./container-files.ts";

// Hash source rather than resolved values: no credentials or providers are needed.
// Include local imports and referenced source URLs, the dependency pin and patches.
// Build outputs and the architecture tooling cannot feed back into this digest.
export function stackFingerprint(root: string): string {
  const sources = new Map<string, string>();
  const visit = (path: string): void => {
    const file = relative(root, path).replaceAll("\\", "/");
    if (file.startsWith("../") || file.startsWith("scripts/architecture/") ||
        /(?:^|\/)(?:node_modules|dist|generated|\.generated|\.alchemy)\//.test(file) || sources.has(file)) return;
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      if (existsSync(join(path, "Dockerfile"))) for (const input of containerInputs(path)) visit(input);
      return;
    }
    const text = readFileSync(path, "utf8");
    sources.set(file, text);
    if (!/\.[cm]?tsx?$/.test(path)) return;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visitNode = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) && node.text.startsWith(".")) {
        const reference = resolve(dirname(path), node.text.replace(/\.js$/, ".ts"));
        if (existsSync(reference) && statSync(reference).isDirectory() && existsSync(join(reference, "Dockerfile"))) visit(reference);
        for (const candidate of [reference, `${reference}.ts`, join(reference, "index.ts")]) {
          if (/\.(?:[cm]?tsx?|json)$/.test(candidate) && existsSync(candidate)) {
            visit(candidate);
            break;
          }
        }
      }
      ts.forEachChild(node, visitNode);
    };
    visitNode(source);
  };
  visit(join(root, "alchemy.run.ts"));
  visit(join(root, "scripts/environment.ts"));
  visit(join(root, "upstream.json"));
  for (const patch of filesBelow(join(root, "patches")).filter(file => file.endsWith(".patch"))) visit(patch);
  const hash = createHash("sha256");
  for (const [file, text] of [...sources].sort(([a], [b]) => a.localeCompare(b)))
    hash.update(file).update("\0").update(text).update("\0");
  return hash.digest("hex");
}
