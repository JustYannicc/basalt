import type TypeScript from "../../.upstream/node_modules/typescript-5/lib/typescript.d.ts";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, matchesGlob, relative, resolve } from "node:path";
import { codeFiles } from "./e2e-inventory.ts";

import { activeSteps, shellCommands, type Workflow } from "./e2e-workflow.ts";

export function scriptCoverage(root: string, workflow: Workflow) {
  const ts = createRequire(join(root, ".upstream/package.json"))(
    "typescript-5",
  ) as typeof TypeScript;
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
    if (!/\.[cm]?[jt]sx?$/.test(file)) return;
    const source = ts.createSourceFile(
      file,
      readFileSync(join(root, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const module = (node: TypeScript.Node | undefined) => {
      if (!node || !ts.isStringLiteralLike(node)) return;
      const path = node.text;
      if (!path.startsWith(".")) return;
      const target = relative(root, resolve(root, dirname(file), path));
      if (/\.[cm]?[jt]sx?$/.test(target)) visit(target);
    };
    const walk = (node: TypeScript.Node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
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
        const argumentsList = node.arguments[1];
        if (argumentsList && ts.isArrayLiteralExpression(argumentsList))
          for (const argument of argumentsList.elements) {
            const scan = (child: TypeScript.Node) => {
              if (
                ts.isStringLiteralLike(child) &&
                /^(?:\.\/)?(?:e2e|scripts)\/[^\s]+\.[cm]?[jt]sx?$/.test(child.text)
              )
                visit(child.text.replace(/^\.\//, ""));
              ts.forEachChild(child, scan);
            };
            scan(argument);
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
    if (cwd === ".")
      for (const match of command.matchAll(/(?:npm|bun) run ([\w:-]+)/g))
        if (
          packageScripts[match[1]!]! &&
          !commands.some((item) => item.command === packageScripts[match[1]!]!)
        )
          commands.push(
            ...shellCommands(packageScripts[match[1]!]!).map((command) => ({
              job: commands[i]!.job,
              command,
              cwd,
            })),
          );
    for (const line of shellCommands(command)) {
      for (const match of line.matchAll(/(?:^|[\s"'])([.\w/*-]+\.[cm]?[jt]sx?)(?=$|[\s"'])/g)) {
        const path = relative(root, resolve(root, cwd, match[1]!));
        if (path.startsWith(".upstream/")) continue;
        if (path.includes("*")) scripts.filter((file) => matchesGlob(file, path)).forEach(visit);
        else visit(path);
      }
    }
  }
  return { scripts, reached };
}
