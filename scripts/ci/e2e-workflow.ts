export type Step = {
  run?: string;
  if?: string | boolean;
  "continue-on-error"?: boolean;
  "working-directory"?: string;
};
export type Workflow = {
  jobs: Record<
    string,
    {
      if?: string | boolean;
      "continue-on-error"?: boolean;
      steps?: Step[];
      strategy?: { matrix?: unknown };
    }
  >;
};

const conditionCanRun = (condition: string | boolean | undefined, job = false) => {
  if (condition === undefined || condition === true) return true;
  if (typeof condition !== "string") return false;
  const expression = condition.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1");
  return (
    [
      "true",
      "always()",
      "success()",
      "needs.select.outputs.full_suite == 'true'",
      "needs.select.outputs.full_suite != 'true'",
    ].includes(expression) ||
    (job &&
      /^contains\(fromJSON\(needs\.select\.outputs\.(?:hosted_jobs|jobs)\), '[\w-]+'\)$/.test(
        expression,
      ))
  );
};

export const activeSteps = (job: Workflow["jobs"][string] | undefined) =>
  job?.["continue-on-error"] || !conditionCanRun(job?.if, true)
    ? []
    : (job?.steps ?? []).filter(
        (step): step is Step & { run: string } =>
          typeof step.run === "string" && !step["continue-on-error"] && conditionCanRun(step.if),
      );

// Only executable command positions count. Mentioning a path in echo, comments or artifacts is not coverage.
export function shellCommands(run: string) {
  return run
    .replace(/\\\n/g, " ")
    .split("\n")
    .flatMap((line) => {
      const match =
        /^\s*(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*(?:node|bun|bunx|npm)\s+(.+)$/.exec(
          line,
        );
      return match ? [match[0].trim()] : [];
    });
}

export function expandedRuns(run: string, job: Workflow["jobs"][string]) {
  const matrix = job.strategy?.matrix;
  if (
    !matrix ||
    typeof matrix !== "object" ||
    !("include" in matrix) ||
    !Array.isArray(matrix.include)
  )
    return [run];
  return matrix.include.map((row: Record<string, unknown>) =>
    run.replace(/\$\{\{ matrix\.([\w]+) \}\}/g, (expression, key: string) =>
      typeof row[key] === "string" ? row[key] : expression,
    ),
  );
}

export function shellWords(command: string) {
  const words: string[] = [];
  let current = "",
    quote = "",
    escaped = false;
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      else current += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "#" && !current) break;
    else if (/\s/.test(character)) {
      if (current) words.push(current);
      current = "";
    } else if (/[;&|]/.test(character)) return [];
    else current += character;
  }
  if (quote || escaped) return [];
  if (current) words.push(current);
  return words;
}

export function commandWords(command: string) {
  const words = shellWords(command);
  while (/^[A-Z_][A-Z0-9_]*=/.test(words[0] ?? "")) words.shift();
  return words;
}

export function executedPaths(command: string) {
  const [runner, ...args] = commandWords(command);
  return executedArgv(runner ?? "", args);
}

export function executedArgv(runner: string, argv: string[]) {
  const args = [...argv];
  if (!["node", "bun"].includes(runner)) return [];
  if (
    args.some((argument) => ["--check", "-c", "--eval", "-e", "--print", "-p"].includes(argument))
  )
    return [];
  if (args[0] === "run") args.shift();
  const paths: string[] = [];
  if (args.includes("--test")) {
    if (args.some((argument) => /^--test-(?:name|skip)-pattern/.test(argument))) return [];
    for (const argument of args.slice(args.indexOf("--test") + 1))
      if (!argument.startsWith("-")) paths.push(argument);
    return paths;
  }
  for (let i = 0; i < args.length; i++) {
    const argument = args[i]!;
    if (["--import", "--require", "-r"].includes(argument)) {
      if (args[i + 1]) paths.push(args[++i]!);
      continue;
    }
    if (argument.startsWith("-")) return [];
    paths.push(argument);
    break;
  }
  return paths;
}

export function selectorReferenced(run: string, group: string) {
  return run
    .split("\n")
    .some((line) =>
      shellWords(line).some((word) =>
        ["scripts/ci/e2e-pattern.ts", "../scripts/ci/e2e-pattern.ts"].some(
          (path) =>
            word === `$(node ${path} ${group})` ||
            (/^BASALT_(?:SCOPE|ADOPTION)_PROOF_PATTERN=/.test(word) &&
              word.endsWith(`=$(node ${path} ${group})`)),
        ),
      ),
    );
}

export function delegatedCommand(command: string) {
  const words = commandWords(command);
  if (
    !executedPaths(command).some((path) =>
      ["scripts/ci/run-e2e.ts", "../scripts/ci/run-e2e.ts"].includes(path),
    )
  )
    return words;
  const delimiter = words.indexOf("--");
  return delimiter === -1 ? [] : words.slice(delimiter + 1);
}
