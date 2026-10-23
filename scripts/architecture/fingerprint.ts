import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { filesBelow } from "./files.ts";
import { containerInputs } from "./container-files.ts";

function assetFiles(path: string, root: string, seen = new Set<string>()): string[] {
  const actual = realpathSync(path);
  const offset = relative(realpathSync(root), actual);
  if (offset === ".." || offset.startsWith("../")) throw new Error("Asset input escapes repository");
  if (seen.has(actual)) return [];
  seen.add(actual);
  return statSync(path).isDirectory()
    ? readdirSync(path).sort().flatMap(name => assetFiles(join(path, name), root, seen)) : [path];
}

// Hash source rather than resolved values: no credentials or providers are needed.
// Include local imports and referenced source URLs, the dependency pin and patches.
// Build outputs and the architecture tooling cannot feed back into this digest.
export function stackFingerprint(root: string): string {
  const sources = new Map<string, Buffer>();
  const directories = new Set<string>();
  const visit = (path: string): void => {
    const file = relative(root, path).replaceAll("\\", "/");
    // The dependency's authoritative inputs are its pin and carried patches.
    // Its generated checkout can contain platform-specific and built files.
    if (file.startsWith("../") || file === ".upstream" || file.startsWith(".upstream/") || file.startsWith("scripts/architecture/") ||
        /(?:^|\/)(?:node_modules|dist|generated|\.generated|\.alchemy)(?:\/|$)/.test(file) || sources.has(file)) return;
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      if (directories.has(file)) return;
      directories.add(file);
      const inputs = existsSync(join(path, "Dockerfile")) ? containerInputs(path) : assetFiles(path, root);
      for (const input of inputs) visit(input);
      return;
    }
    const text = readFileSync(path);
    sources.set(file, text);
    if (!/\.[cm]?tsx?$/.test(path)) return;
    const source = ts.createSourceFile(path, text.toString("utf8"), ts.ScriptTarget.Latest, true);
    const visitNode = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) && node.text.startsWith(".")) {
        const reference = resolve(dirname(path), node.text.replace(/\.js$/, ".ts"));
        if (ts.isNewExpression(node.parent) && node.parent.expression.getText(source) === "URL" &&
            node.parent.arguments?.[0] === node && existsSync(reference) && statSync(reference).isDirectory()) visit(reference);
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
  visit(join(root, "package.json"));
  for (const workflow of filesBelow(join(root, ".github/workflows")).filter(file => /\.ya?ml$/.test(file))) visit(workflow);
  for (const patch of filesBelow(join(root, "patches")).filter(file => file.endsWith(".patch"))) visit(patch);
  const hash = createHash("sha256");
  for (const [file, text] of [...sources].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    hash.update(file).update("\0").update(text).update("\0");
  return hash.digest("hex");
}
