import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix } from "node:path";
import { commandWords, shellWords, type Step as RunStep, type Workflow } from "./e2e-workflow.ts";
import { isTest } from "./import-graph.ts";
import { directoryFiles, fileMatcher } from "./inputs.ts";

type Step = RunStep & { uses?: string };

const { parse } = createRequire(new URL("../architecture/package.json", import.meta.url))("yaml");

export const readWorkflow = (root: string, path = ".github/workflows/ci.yml"): Workflow =>
  parse(readFileSync(join(root, path), "utf8"));

// The simple commands of a step's script. Unquoted newlines, `&&`, `||`, `;` and pipes end a
// command, `#` starts a comment, each `$(…)` substitution is a command of its own (innermost
// first), and here-document bodies are data.
export function commands(run: string): string[] {
  const lines: string[] = [];
  let heredoc = "";
  for (const line of run.replace(/\\\n/g, " ").split("\n")) {
    if (heredoc) {
      if (line.trim() === heredoc) heredoc = "";
      continue;
    }
    heredoc = /(?<!<)<<(?!<)-?\s*['"]?(\w+)['"]?/.exec(line)?.[1] ?? "";
    lines.push(line);
  }
  let text = lines.join("\n");
  const parts: string[] = [];
  for (let inner = /\$\(([^()]*)\)/.exec(text); inner; inner = /\$\(([^()]*)\)/.exec(text)) {
    parts.push(inner[1]!);
    text = text.slice(0, inner.index) + "$SUBSTITUTED" + text.slice(inner.index + inner[0].length);
  }
  const result: string[] = [];
  for (const part of [text, ...parts]) {
    let current = "",
      quote = "",
      comment = false;
    for (const character of part) {
      if (comment) {
        if (character !== "\n") continue;
        comment = false;
      }
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") quote = character;
      else if (character === "#" && /(?:^|\s)$/.test(current)) {
        comment = true;
        continue;
      } else if (/[\n;|&]/.test(character)) {
        result.push(current);
        current = "";
        continue;
      }
      current += character;
    }
    result.push(current);
  }
  return result.map((command) => command.trim()).filter(Boolean);
}

/** A step condition true only in the full suite: the affected lane never runs that step. */
export const fullOnly = "steps.lane.outputs.full_suite == 'true'";

/**
 * The repository files each workflow job's own steps name: the scripts and test files they run,
 * the directories and files they pass to a build, and the same for the local actions and package
 * scripts those steps call. A step's words count relative to its working directory; `.upstream`
 * is prepared later from the carries, so its paths never count. With `lane`, only the steps the
 * affected lane runs count.
 */
export function jobEntries(
  root: string,
  workflow: Workflow,
  files: readonly string[],
  { lane = false } = {},
) {
  const tracked = new Set(files);
  const directories = directoryFiles(files);
  const below = (directory: string) => directories.get(directory) ?? [];
  const matching = fileMatcher(files);
  const manifests = new Map<string, Record<string, string>>();
  const scripts = (directory: string) => {
    if (!manifests.has(directory)) {
      const path = join(root, directory, "package.json");
      manifests.set(
        directory,
        tracked.has(posix.join(directory, "package.json")) && existsSync(path)
          ? (JSON.parse(readFileSync(path, "utf8")).scripts ?? {})
          : {},
      );
    }
    return manifests.get(directory)!;
  };
  const named = (cwd: string, word: string): string[] => {
    if (!word || /[$`]/.test(word) || word.startsWith("-")) return [];
    const path = posix.normalize(posix.join(cwd, word.replace(/^[A-Za-z_]\w*=/, "")));
    if (path === "." || path.startsWith("../") || path.startsWith("/")) return [];
    if (path === ".upstream" || path.startsWith(".upstream/")) return [];
    if (tracked.has(path)) return [path];
    // Bare words such as `*` in a configuration line are not paths; globs name a directory.
    if (!path.includes("/")) return [];
    if (/[*?{[]/.test(path)) return matching(path);
    return below(path);
  };
  const visit = (run: string, cwd: string, entries: Set<string>, depth = 0) => {
    for (const command of commands(run)) {
      const line = command.replace(/^(?:export|sudo|exec|time)\s+/, "");
      // A command this reader cannot split would hide its inputs; selection then runs everything.
      if (!shellWords(line).length)
        throw new Error("Unsupported shell in a workflow step: " + command);
      const words = commandWords(line);
      // A working directory, or a path only made, moved or removed, is not read as input.
      if (!/^(?:cd|mkdir|rm|mv|echo|test|ls|tee|touch)$/.test(words[0] ?? ""))
        for (const [index, word] of words.entries())
          if (
            !/^(?:--cwd|--prefix|-C|--directory|-o|--output|--outputFile|--outdir)$/.test(
              words[index - 1] ?? "",
            )
          )
            for (const path of named(cwd, word.replace(/^--(?:cwd|prefix)=.*/, "")))
              entries.add(path);
      if (depth > 8) continue;
      const [runner, ...rest] = words;
      // `npm run x`, `bun run --cwd dir x`: the package script runs in its package's directory.
      if (["npm", "bun", "pnpm"].includes(runner ?? "") && rest.includes("run")) {
        let directory = cwd;
        const args = rest.slice(rest.indexOf("run") + 1);
        const name = args.find((arg, index) => {
          if (arg === "--cwd" || arg === "--prefix")
            directory = posix.join(cwd, args[index + 1] ?? "");
          else if (/^--(?:cwd|prefix)=/.test(arg)) directory = posix.join(cwd, arg.split("=")[1]!);
          return (
            !arg.startsWith("-") && args[index - 1] !== "--cwd" && args[index - 1] !== "--prefix"
          );
        });
        const body = name && scripts(posix.normalize(directory))[name];
        if (body) visit(body, posix.normalize(directory), entries, depth + 1);
      }
      // Vitest without file arguments runs every test file below its directory.
      const vitest = words.indexOf("vitest");
      if (vitest >= 0 && words[vitest + 1] === "run" && !cwd.startsWith(".upstream"))
        for (const file of cwd === "." ? files : below(cwd)) if (isTest(file)) entries.add(file);
    }
  };
  const steps = (list: readonly Step[] | undefined, depth = 0): Step[] =>
    (list ?? []).flatMap((step) => {
      const action = step.uses?.startsWith("./") ? posix.join(step.uses, "action.yml") : "";
      if (!action || !tracked.has(action) || depth > 4) return [step];
      const nested = (readWorkflow(root, action) as unknown as { runs?: { steps?: Step[] } }).runs;
      return [step, ...steps(nested?.steps, depth + 1)];
    });
  return Object.fromEntries(
    Object.entries(workflow.jobs).map(([job, value]) => {
      const entries = new Set<string>();
      for (const step of steps(value.steps))
        if (typeof step.run === "string" && !(lane && step.if === fullOnly))
          visit(step.run, posix.normalize(step["working-directory"] ?? "."), entries);
      return [job, entries];
    }),
  );
}
