/**
 * Whether a candidate tree deploys a rehearsal stage into the lane's own stack. The lane destroys
 * and verifies only `stackNameForStage(stage)`, so a candidate that names another stack for the
 * stage (main names `basalt`, production's) would leave everything it deploys standing unseen.
 *
 * The signal is the one the heal candidates' stage-only overlay added to `alchemy.run.ts`: the
 * stack is named `stackNameForStage(process.env.ALCHEMY_STAGE)`, and the stage's preview names come
 * from `disposableStageNames(stage)` or `subjectFromStage(stage)`, each imported from the
 * candidate's own tree. The stack file is only read as text; the two functions run in a child with
 * no secrets, never in this process, and the stack itself is never evaluated.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { stackNameForStage } from "../release-barrier/release-stage.ts";

const stackCall =
  /\bAlchemy\.Stack\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|(stackNameForStage\(\s*process\.env\.ALCHEMY_STAGE\s*\)))\s*,/gu;
const namerCall = /\b(disposableStageNames|subjectFromStage)\(\s*stage\s*\)/u;
const namedImport = /^import\s*\{([^}]*)\}\s*from\s*"(\.{1,2}\/[^"]+\.ts)";/gmu;

/** The candidate module a stack-file name is imported from, and its exported name there. */
function importOf(text: string, tree: string, local: string) {
  for (const [, names, from] of text.matchAll(namedImport)) {
    for (const spec of names!.split(",")) {
      const [exported, alias] = spec.trim().split(/\s+as\s+/u);
      if ((alias ?? exported) !== local) continue;
      const path = resolve(tree, from!);
      // Its own file, not a link that hands over another tree's function.
      const own =
        existsSync(path) &&
        !lstatSync(path).isSymbolicLink() &&
        (() => {
          const inner = relative(realpathSync(tree), realpathSync(path));
          return inner !== "" && !inner.startsWith(`..${sep}`) && !isAbsolute(inner);
        })();
      return own ? { url: pathToFileURL(path).href, exported: exported! } : undefined;
    }
  }
  return undefined;
}

// Run in the child: import each module, call its function on the stage, print what it returned.
const probe = `
const [stage, stack, namer] = JSON.parse(process.argv[1]);
const call = async ({ url, exported }) => (await import(url))[exported](stage);
const named = stack ? await call(stack) : undefined;
const names = await call(namer);
console.log(JSON.stringify({ stack: named, disposable: names !== undefined && names !== null }));
`;

/**
 * Refuses, before any candidate entry runs or any stage env is built, a candidate that would not
 * deploy `stage` into the lane's own stack or would take it for production. Same tree: nothing.
 */
export function requireCandidateStack(
  harness: string,
  tree: string,
  stage: string,
  source: NodeJS.ProcessEnv = process.env,
) {
  if (tree === harness) return;
  const lane = stackNameForStage(stage);
  const unhandled = (why: string) =>
    new Error(
      `The candidate has no rehearsal-stage handling (${why}), so the lane's destroy could not be shown to remove what it deploys; nothing is deployed`,
    );
  const file = join(tree, "alchemy.run.ts");
  if (!existsSync(file) || lstatSync(file).isSymbolicLink())
    throw unhandled("no stack file of its own");
  const text = readFileSync(file, "utf8");
  const calls = [...text.matchAll(stackCall)];
  if (calls.length !== 1)
    throw unhandled("its stack is named neither through stackNameForStage nor as a plain name");
  const [, double, single, through] = calls[0]!;
  const plain = double ?? single;
  const wrongStack = (named: unknown) =>
    new Error(
      `The candidate names stack ${String(named)} for this stage, not the lane's ${lane}, so the lane's destroy could not remove what it deploys; nothing is deployed`,
    );
  if (plain !== undefined && plain !== lane) throw wrongStack(plain);
  const stack = through ? importOf(text, tree, "stackNameForStage") : undefined;
  if (through && !stack) throw unhandled("stackNameForStage is not its own tree's");
  const namerName = namerCall.exec(text)?.[1];
  const namer = namerName ? importOf(text, tree, namerName) : undefined;
  if (!namer) throw unhandled("no preview names of its own tree for a rehearsal stage");

  let answer: { stack?: unknown; disposable?: unknown };
  try {
    answer = JSON.parse(
      execFileSync(
        process.execPath,
        ["--input-type=module", "-e", probe, JSON.stringify([stage, stack, namer])],
        {
          cwd: tree,
          // No stage env and no secrets: naming a stage needs neither.
          env: { PATH: source.PATH, HOME: source.HOME, TMPDIR: source.TMPDIR },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 60_000,
        },
      )
        .trim()
        .split("\n")
        .at(-1)!,
    ) as typeof answer;
  } catch {
    throw unhandled("its stage naming could not be run");
  }
  if (stack && answer.stack !== lane) throw wrongStack(answer.stack);
  if (answer.disposable !== true)
    throw new Error(
      "The candidate takes this stage for production (its preview names do not cover a rehearsal stage), so it would deploy production's names into the lane; nothing is deployed",
    );
}
