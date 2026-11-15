import { createRequire } from "node:module";
const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const ts: typeof import("../../.upstream/node_modules/typescript-5/lib/typescript.js") = require("typescript-5");
import { provisioningRefusal } from "./provisioning-refusal.ts";

/** A current bundle may already export an unbound runtime class; adding a second export breaks the Worker. */
export function runtimeModuleExports(name: string, contentBase64: string, className: string) {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(contentBase64, "base64"));
  } catch {
    throw provisioningRefusal(
      "provisioning-namespace-module-unsupported",
      "namespace.mainModule",
      "UTF-8-javascript",
      "invalid",
    );
  }
  const diagnostics = ts.transpileModule(text, {
    fileName: name,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).diagnostics;
  if (diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error))
    throw provisioningRefusal(
      "provisioning-namespace-module-unsupported",
      "namespace.mainModule",
      "parseable-javascript",
      "invalid",
    );
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  let matches = 0,
    wildcard = false;
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      if (!statement.exportClause) wildcard = true;
      else if (ts.isNamedExports(statement.exportClause))
        matches += statement.exportClause.elements.filter(
          (entry) => !entry.isTypeOnly && entry.name.text === className,
        ).length;
    } else if (
      (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) &&
      statement.name?.text === className
    ) {
      const modifiers = ts.getModifiers(statement) ?? [];
      if (
        modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
        !modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
      )
        matches++;
    }
  }
  if (matches > 1 || (!matches && wildcard))
    throw provisioningRefusal(
      "provisioning-namespace-module-unsupported",
      "namespace.exports",
      "one-exact-export-or-proven-absence",
      "unconfirmed",
    );
  return matches === 1;
}
