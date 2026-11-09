import ts from "../architecture/typescript.ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, matchesGlob, relative, resolve } from "node:path";
import { codeFiles } from "./e2e-inventory.ts";

import {
  activeSteps,
  shellCommands,
  commandWords,
  executedPaths,
  executedArgv,
  type Workflow,
} from "./e2e-workflow.ts";

// These runners typecheck and execute template source from a generated directory.
const executedTemplates: Record<string, readonly string[]> = {
  "e2e/obsidian/installed.test.ts": ["e2e/obsidian/installed.fixture.ts.txt"],
};

export function scriptCoverage(root: string, workflow: Workflow) {
  const scripts = codeFiles(join(root, "e2e")).map((file) => relative(root, file));
  const reached = new Set<string>();
  const commands = Object.entries(workflow.jobs).flatMap(([job, value]) =>
    activeSteps(value).flatMap((step) =>
      shellCommands(step.run).map((command) => ({
        job,
        command,
        cwd: step["working-directory"] ?? ".",
      })),
    ),
  );
  const visit = (file: string) => {
    if (reached.has(file) || !/^(?:e2e|scripts)\//.test(file) || !existsSync(join(root, file)))
      return;
    reached.add(file);
    if (!/\.[cm]?[jt]sx?$/.test(file) && !file.endsWith(".fixture.ts.txt")) return;
    for (const template of executedTemplates[file] ?? []) visit(template);
    const source = ts.createSourceFile(
      file,
      readFileSync(join(root, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const module = (node: ts.Node | undefined) => {
      if (!node || !ts.isStringLiteralLike(node)) return;
      const path = node.text;
      if (!path.startsWith(".")) return;
      const target = relative(root, resolve(root, dirname(file), path));
      if (/\.[cm]?[jt]sx?$/.test(target)) visit(target);
    };
    const walk = (node: ts.Node) => {
      if (
        ts.isImportDeclaration(node) &&
        !node.importClause?.isTypeOnly &&
        !(
          node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings) &&
          !node.importClause.name &&
          node.importClause.namedBindings.elements.every((item) => item.isTypeOnly)
        )
      )
        module(node.moduleSpecifier);
      if (
        ts.isExportDeclaration(node) &&
        !node.isTypeOnly &&
        !(
          node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.every((item) => item.isTypeOnly)
        )
      )
        module(node.moduleSpecifier);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
        module(node.arguments[0]);
      // CLI wrappers name their child scripts as argv strings rather than imports.
      if (
        ts.isCallExpression(node) &&
        /^(?:run|spawn|spawnSync|execFile|execFileSync|ChildProcess\.make)$/.test(
          node.expression.getText(source),
        )
      ) {
        const executable = node.arguments[0];
        const runner =
          executable && ts.isStringLiteralLike(executable)
            ? executable.text
            : executable?.getText(source) === "process.execPath"
              ? "node"
              : "";
        const argumentsList = node.arguments[1];
        if (
          ["node", "bun"].includes(runner) &&
          argumentsList &&
          ts.isArrayLiteralExpression(argumentsList)
        ) {
          const argv = argumentsList.elements.map((argument) => {
            if (ts.isStringLiteralLike(argument)) return argument.text;
            if (
              ts.isCallExpression(argument) &&
              ["join", "resolve"].includes(argument.expression.getText(source))
            ) {
              return (
                argument.arguments
                  .find(
                    (part) => ts.isStringLiteralLike(part) && /^(?:e2e|scripts)\//.test(part.text),
                  )
                  ?.getText(source)
                  .slice(1, -1) ?? "<dynamic>"
              );
            }
            return "<dynamic>";
          });
          for (const path of executedArgv(runner, argv)) visit(path.replace(/^\.\//, ""));
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  const packageScripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    .scripts as Record<string, string>;
  for (let i = 0; i < commands.length; i++) {
    const { command, cwd } = commands[i]!;
    const words = commandWords(command);
    if (cwd === "." && ["npm", "bun"].includes(words[0] ?? "") && words[1] === "run") {
      const body = packageScripts[words[2] ?? ""];
      if (body && !commands.some((item) => item.command === body))
        commands.push(
          ...shellCommands(body).map((command) => ({ job: commands[i]!.job, command, cwd })),
        );
    }
    for (const argument of executedPaths(command)) {
      const path = relative(root, resolve(root, cwd, argument));
      if (path.startsWith(".upstream/")) continue;
      if (path.includes("*")) scripts.filter((file) => matchesGlob(file, path)).forEach(visit);
      else visit(path);
    }
  }
  return { scripts, reached };
}
