// Judges a change to Basalt's own `alchemy.run.ts` line by line. Most edits add or adjust resources
// that name neither the database nor a Workflow host, such as a zone ruleset. A changed line counts
// when it, a line within three of it, or the call that encloses it names the stack, its state
// store, the stage, the database, or a Workflow host's identity. A Worker counts through its `name:`.
// Control flow, indirect resource groups and unreviewed local imports can skip or add resources this
// cannot see, so they are unknown.
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
/** Durable Objects keep state by class, name and jurisdiction. */
const durableIdentity = /\bDurableObject\b|\bjurisdiction\b/;
const databaseIdentity = [/\bPlanet[sS]cale\b|\bPostgres(?:Database|Role|Branch)\b|\bHyperdrive\b|database/i, durableIdentity];
const workflowIdentity = [/workflow/i, /workerName|scriptName/i, durableIdentity, /\bclassName\s*:|\bContainer\s*\(/];
const workerCall = /\bWorker\s*\(/;
const workerName = /\bname\s*:/;

/** Database and Workflow impact of changing the stack file from `before` to `after`. */
export function stackImpact(before: string, after: string): { database: CarryImpact; workflow: CarryImpact } {
  const sides = [before.split("\n"), after.split("\n")];
  if (sides.some((lines) => !balanced(lines))) {
    const unknown: CarryImpact = { state: "unknown", detail: "has brackets this cannot match, so its calls are unknown" };
    return { database: unknown, workflow: unknown };
  }
  const [removed, added] = changedIndices(sides[0]!, sides[1]!);
  const changes: Change[] = [removed, added].flatMap((changed, side) => {
    const lines = sides[side]!;
    return [...changed].map((index) => {
      const head = enclosingCall(lines, index);
      return {
        line: lines[index]!,
        // A neighbouring import names a module, not what this line declares.
        near: lines.slice(Math.max(0, index - window), index + window + 1)
          .filter((line) => line === lines[index] || !/^\s*import\b/.test(line)),
        head,
        opaque: opaqueReason(lines, index, side === 1 ? added : undefined, head),
        specifier: importSpecifier(lines, index),
      };
    });
  });
  const quote = (lines: string[]) => lines.map((line) => `\`${line.trim().slice(0, 80)}\``).join(", ");
  const judge = (area: string, hit: (change: Change) => boolean): CarryImpact => {
    const lines = changes.filter((change) => identitySpecifier.test(change.specifier ?? "\0") ||
      carriers.some((rule) => rule.test(change.line)) || hit(change)).map(({ line }) => line);
    if (lines.length) return { state: "changed", detail: `changes ${area} identity at ${quote(lines)}` };
    const opaque = changes.filter(({ opaque }) => opaque);
    if (opaque.length)
      return { state: "unknown", detail: opaque.map(({ line, opaque }) => `${opaque} at ${quote([line])}`).join("; ") };
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

/** Statements that can skip, end or repeat the resources declared after them. */
const controlFlow = /\b(?:return|throw|if|else|for|while|do|switch|case|try|catch|finally|break|continue|interrupt)\b|\bprocess\.exit\b|\bEffect\.(?!gen\b|orDie\b)\w+/;
const exits = /\b(?:return|throw|break|continue|else|interrupt)\b|\bprocess\.exit\b|\bEffect\.(?!gen\b|orDie\b)\w+/;
/** `yield*` operands that construct one resource or read one setting directly. */
const directConstructor = /^(?:Cloudflare|Config)\./;
/** A name the stack's constructors and policies resolve through, rebound. */
const shadowing = /\b(?:const|let|var|function|class)\s+(?:Alchemy|Cloudflare|Command|Config|Effect|Stage)\b/;
/** Specifiers whose import brings the stack's identity in: the upstream stack, the pool, alchemy. */
const identitySpecifier = /^(?:\.\/\.upstream\/|\.\/src\/pool\/|alchemy\b)/;
/**
 * Local modules reviewed as pure helpers for resource props: they declare no resources and read
 * no settings. `src/browser-check.ts` builds the API-path rule expression from constants.
 */
export const reviewedHelpers = new Set(["src/browser-check.ts"]);

type Change = { line: string; near: string[]; head?: string; opaque?: string; specifier?: string };

/** Why a changed line hides what resources the stack declares, if it does. */
function opaqueReason(lines: string[], index: number, added: Set<number> | undefined, head: string | undefined): string | undefined {
  const code = withoutComments(lines[index]!);
  if (!code.trim() || /^\s*\*(?:\s|$)/.test(code)) return undefined;
  const bare = stripped(code);
  if (controlFlow.test(bare) && !(added && wrapsOnlyAddedCode(lines, index, added)))
    return "changes control flow that can skip resources";
  if (shadowing.test(bare)) return "rebinds a name the stack's resources resolve through";
  if (/\bCommand\./.test(code) || /\bCommand\./.test(head ?? "")) return "runs a command at deploy";
  if (/\bimport\s*\(|\brequire\s*\(/.test(bare)) return "loads a module at run time";
  if (/^\s*export\b/.test(bare) && !/^\s*export\s+default\s+Alchemy\.Stack\s*\(/.test(bare)) return "exports from the stack file";
  // Strings stay in: a template's `${yield* ...}` still runs.
  const yields = [...code.matchAll(/\byield\b\s*(\*)?\s*(?:yield\s*\*\s*)?\(?\s*([\w$.]*)/g)];
  if (yields.some(([, star, operand]) => !star || !directConstructor.test(operand ?? "")))
    return "runs a resource group this cannot see";
  if (yields.length && /\?(?!\.)|&&|\|\|/.test(bare)) return "creates a resource conditionally";
  const specifier = importSpecifier(lines, index);
  if (specifier !== undefined && /^\.{1,2}\//.test(specifier) && !identitySpecifier.test(specifier) &&
    !reviewedHelpers.has(specifier.replace(/^\.\//, "")))
    return "imports a local module nobody reviewed as declaring nothing";
  return undefined;
}

/**
 * The module specifier of the import statement that line `index` belongs to, including a line
 * inside a multi-line import's binding list.
 */
function importSpecifier(lines: string[], index: number): string | undefined {
  let start = index;
  while (start > 0 && !/^\s*import\b/.test(lines[start]!) && /^\s*[\w$\s,{}*]*$/.test(lines[start]!)) start--;
  if (!/^\s*import\b/.test(lines[start]!)) return undefined;
  for (let row = start; row < lines.length && row <= start + 50; row++) {
    const specifier = /\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/.exec(lines[row]!);
    if (specifier) return row >= index ? specifier[1] ?? specifier[2] : undefined;
  }
  return undefined;
}

/**
 * An added `if (...) {` whose whole block, through its closing `}`, is added and never exits only
 * guards new code; it cannot skip a resource that was already declared.
 */
function wrapsOnlyAddedCode(lines: string[], index: number, added: Set<number>): boolean {
  if (!/^\s*if\s*\(.*\)\s*\{\s*$/.test(stripped(withoutComments(lines[index]!)))) return false;
  let depth = 0;
  for (let row = index; row < lines.length; row++) {
    if (!added.has(row)) return false;
    const code = stripped(withoutComments(lines[row]!));
    if (row > index && exits.test(code)) return false;
    for (const char of code) {
      if ("({[".includes(char)) depth++;
      else if (")}]".includes(char)) depth--;
    }
    if (depth === 0) return /^\s*\}\s*;?\s*$/.test(code);
  }
  return false;
}

/** A line without block comments and a `//` comment, keeping strings. */
function withoutComments(line: string): string {
  return line.replace(/\/\*.*?\*\//g, " ").replace(/(^|\s)\/\/.*$/, "$1");
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
