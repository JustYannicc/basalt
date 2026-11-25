import { existsSync, readFileSync } from "node:fs";
import { dirname, join, matchesGlob, relative, resolve } from "node:path";
import { codeFiles } from "./e2e-inventory.ts";
import { isCode, sourceReferences } from "./import-graph.ts";

import {
  activeSteps,
  shellCommands,
  commandWords,
  executedPaths,
  executedArgv,
  delegatedCommand,
  type Workflow,
} from "./e2e-workflow.ts";

// These runners typecheck and execute template source from a generated directory.
const executedTemplates: Record<string, readonly string[]> = {
  "e2e/obsidian/installed.test.ts": ["e2e/obsidian/installed.fixture.ts.txt"],
};
// Runners that run a package script's command: fast-units' legs run `npm run check`'s files.
const scriptRunners: Record<string, string> = { "scripts/ci/unit-tests.ts": "check" };

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
    if (!isCode(file) && !file.endsWith(".fixture.ts.txt")) return;
    for (const template of executedTemplates[file] ?? []) visit(template);
    for (const reference of sourceReferences(file, readFileSync(join(root, file), "utf8"))) {
      if (reference.kind === "spawn") visit(reference.specifier);
      if (reference.kind !== "module" || !reference.specifier.startsWith(".")) continue;
      const target = relative(root, resolve(root, dirname(file), reference.specifier));
      if (isCode(target)) visit(target);
    }
  };
  const packageScripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    .scripts as Record<string, string>;
  for (let i = 0; i < commands.length; i++) {
    const { command, cwd } = commands[i]!;
    const words = commandWords(command);
    const runner = cwd === "." ? executedPaths(command).find((path) => path in scriptRunners) : "";
    const script =
      cwd === "." && ["npm", "bun"].includes(words[0] ?? "") && words[1] === "run"
        ? words[2]
        : runner && scriptRunners[runner];
    const body = packageScripts[script ?? ""];
    if (body && !commands.some((item) => item.command === body))
      commands.push(
        ...shellCommands(body).map((command) => ({ job: commands[i]!.job, command, cwd })),
      );
    const paths = executedPaths(command).map((argument) => ({ argument, cwd }));
    // The published-framework wrapper runs its delegated command from the upstream checkout.
    if (
      paths.some(
        ({ argument }) =>
          resolve(root, cwd, argument) === resolve(root, "scripts/ci/with-published-frameworks.ts"),
      )
    ) {
      const [runner, ...argv] = delegatedCommand(command);
      paths.push(
        ...executedArgv(runner ?? "", argv).map((argument) => ({ argument, cwd: ".upstream" })),
      );
    }
    for (const { argument, cwd: executionDirectory } of paths) {
      const path = relative(root, resolve(root, executionDirectory, argument));
      if (path.startsWith(".upstream/")) continue;
      if (path.includes("*")) scripts.filter((file) => matchesGlob(file, path)).forEach(visit);
      else visit(path);
    }
  }
  return { scripts, reached };
}
