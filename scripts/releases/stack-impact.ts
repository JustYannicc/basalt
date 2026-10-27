// Judges a change to Basalt's own `alchemy.run.ts` line by line. Most edits add or adjust resources
// that name neither the database nor a Workflow host, such as a zone ruleset. A changed line counts
// when it, a line within three of it, or the call that encloses it names the stack, its state
// store, the stage, the database, or a Workflow host's identity. A Worker counts through its `name:`.
import type { CarryImpact } from "./classify-patches.ts";
import { changedIndices } from "./patch-diff.ts";

const window = 3;

/** The stack, its state store and the stage name every resource. */
const stackIdentity = [
  /\bAlchemy\.Stack\s*\(/,
  /\bstackState\b|\bstate\s*:/,
  /\bStage\b|\bstageName\b|\bALCHEMY_STAGE\b|:\s*stage\b|\(\s*stage\b|\bstage\s*[,)}\]]/,
];
/**
 * What carries the upstream stack into this one: its deployment, its Workers (the API Worker hosts
 * every Workflow), the pool Worker with its database, the preview database, and the adoption and
 * removal policies that decide whether existing resources are kept. Only a changed line that names
 * one counts; its neighbours, such as the Router's service bindings, change nothing by being near.
 */
const carriers = [
  /\b(?:cloudDeployment|cloudWorkers|cloudProviders|Api|poolWorker|previewDatabase|api|pool)\b/,
  /\b(?:adopt|retain)\s*\(|\bRemovalPolicy\b|\bAdoptPolicy\b/,
];
/** An import from the upstream stack, the pool or alchemy itself brings identity in with it. */
const identityImport = /^\s*import\b.*["'](?:\.\/\.upstream\/|\.\/src\/pool\/|alchemy\b)/;
/** A bare `yield* name;` runs a resource group this cannot see into. */
const opaqueYield = /\byield\*\s+[A-Za-z_$][\w$]*\s*;/;
const databaseIdentity = [/\bPlanet[sS]cale\b|\bPostgres(?:Database|Role|Branch)\b|\bHyperdrive\b|database/i];
const workflowIdentity = [/workflow/i, /workerName|scriptName/i, /\bDurableObject\b|\bjurisdiction\b/];
const workerCall = /\bWorker\s*\(/;
const workerName = /\bname\s*:/;

type Change = { line: string; near: string[]; head?: string };

/** Database and Workflow impact of changing the stack file from `before` to `after`. */
export function stackImpact(before: string, after: string): { database: CarryImpact; workflow: CarryImpact } {
  const sides = [before.split("\n"), after.split("\n")];
  if (sides.some((lines) => !balanced(lines))) {
    const unknown: CarryImpact = { state: "unknown", detail: "has brackets this cannot match, so its calls are unknown" };
    return { database: unknown, workflow: unknown };
  }
  const changes: Change[] = changedIndices(sides[0]!, sides[1]!).flatMap((changed, side) => {
    const lines = sides[side]!;
    return [...changed].map((index) => ({
      line: lines[index]!,
      // A neighbouring import names a module, not what this line declares.
      near: lines.slice(Math.max(0, index - window), index + window + 1)
        .filter((line) => line === lines[index] || !/^\s*import\b/.test(line)),
      head: enclosingCall(lines, index),
    }));
  });
  const quote = (lines: string[]) => lines.map((line) => `\`${line.trim().slice(0, 80)}\``).join(", ");
  const judge = (area: string, hit: (change: Change) => boolean): CarryImpact => {
    const lines = changes.filter((change) => identityImport.test(change.line) ||
      carriers.some((rule) => rule.test(change.line)) || hit(change)).map(({ line }) => line);
    if (lines.length) return { state: "changed", detail: `changes ${area} identity at ${quote(lines)}` };
    const opaque = changes.filter(({ line }) => opaqueYield.test(line)).map(({ line }) => line);
    if (opaque.length) return { state: "unknown", detail: `runs resources this cannot see at ${quote(opaque)}` };
    return { state: "unchanged" };
  };
  const names = (rules: RegExp[], change: Change) =>
    [...change.near, change.head ?? ""].some((line) => rules.some((rule) => rule.test(line)));
  return {
    database: judge("database", (change) => names([...stackIdentity, ...databaseIdentity], change)),
    workflow: judge("Workflow", (change) => names([...stackIdentity, ...workflowIdentity], change) ||
      workerName.test(change.line) && workerCall.test(change.head ?? "")),
  };
}

/**
 * The nearest line that opens a call enclosing line `index`, through object and array literals.
 * The line's own closers count, so `}).pipe(...)` finds the call its `}` closes.
 */
function enclosingCall(lines: string[], index: number): string | undefined {
  let depth = 0;
  let open = 0;
  for (const char of stripped(lines[index]!)) {
    if ("({[".includes(char)) open++;
    else if (")}]".includes(char)) { if (open) open--; else depth++; }
  }
  for (let row = index - 1; row >= 0; row--) {
    const code = stripped(lines[row]!);
    for (let column = code.length - 1; column >= 0; column--) {
      const char = code[column]!;
      if (")}]".includes(char)) depth++;
      else if ("({[".includes(char)) {
        if (depth) depth--;
        else if (code.slice(0, column + 1).includes("(")) return lines[row];
      }
    }
  }
  return undefined;
}

function balanced(lines: string[]): boolean {
  let depth = 0;
  for (const line of lines)
    for (const char of stripped(line)) {
      if ("({[".includes(char)) depth++;
      else if (")}]".includes(char) && --depth < 0) return false;
    }
  return depth === 0;
}

/** A line without its strings, template text and `//` comment. */
function stripped(line: string): string {
  return line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "\"\"").replace(/\/\/.*$/, "");
}
