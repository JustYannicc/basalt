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

export const activeSteps = (job: Workflow["jobs"][string] | undefined) =>
  job?.["continue-on-error"] || job?.if === false || job?.if === "false"
    ? []
    : (job?.steps ?? []).filter(
        (step): step is Step & { run: string } =>
          typeof step.run === "string" &&
          !step["continue-on-error"] &&
          (step.if === undefined ||
            step.if === true ||
            step.if === "always()" ||
            step.if === "needs.select.outputs.full_suite == 'true'" ||
            step.if === "needs.select.outputs.full_suite != 'true'"),
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
