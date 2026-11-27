/**
 * Whether a candidate tree deploys a rehearsal stage into the lane's own stack. The lane destroys
 * and verifies only `stackNameForStage(stage)`, so a candidate that names another stack for the
 * stage (main names `basalt`, production's) would leave everything it deploys standing unseen.
 *
 * The signal is the one the heal candidates' stage-only overlay added to `alchemy.run.ts`, read
 * from its syntax tree (`stackShape`): the stack is named `stackNameForStage(process.env.ALCHEMY_STAGE)`,
 * and the stage's preview names, from `disposableStageNames(stage)` or `subjectFromStage(stage)`,
 * decide `preview`, which gates every production-only resource. Both functions come from the
 * candidate's own tree and run in a child with no secrets, an empty home, and reads confined to the
 * tree and its dependencies; the stack itself is never evaluated.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { stackNameForStage } from "../release-barrier/release-stage.ts";
import { withEmptyHome } from "./stage-candidate.ts";
import { stackShape, type Imported } from "./stage-candidate-stack-shape.ts";

/**
 * The candidate module an imported name comes from, if it is the tree's own file, by its real path:
 * the probe may read only the tree's real path, and resolving a module stats every component.
 */
function ownModule(tree: string, { from, exported }: Imported) {
  const path = resolve(tree, from);
  // Its own file, not a link that hands over another tree's function.
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return undefined;
  const real = realpathSync(path);
  const inner = relative(realpathSync(tree), real);
  if (inner === "" || inner.startsWith(`..${sep}`) || isAbsolute(inner)) return undefined;
  return { url: pathToFileURL(real).href, exported };
}

// Run in the child: import each module, call its function on the stage, print what it returned.
// Only a stack-shaped name comes back, so nothing else the functions could read leaves the child.
const probe = `
const [stage, stack, namer] = JSON.parse(process.argv[1]);
const call = async ({ url, exported }) => (await import(url))[exported](stage);
const named = await call(stack);
const names = await call(namer);
console.log(JSON.stringify({
  stack: typeof named === "string" && /^[a-z0-9-]{1,64}$/.test(named) ? named : null,
  disposable: typeof names === "object" && names !== null,
}));
`;

/**
 * What the probe may read besides the tree: its `.upstream` checkout and `node_modules`, and the
 * dependency stores their packages link into (a prepared tree's packages live in the shared upstream
 * cache). Only a link into a `node_modules/.bun` store adds its store; any other link adds nothing.
 */
function dependencyReads(tree: string) {
  const reads = new Set<string>();
  for (const name of [".upstream", "node_modules"]) {
    const path = join(tree, name);
    if (existsSync(path)) reads.add(realpathSync(path));
  }
  const modules = join(tree, "node_modules");
  const visit = (dir: string, scoped: boolean) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (!scoped && entry.name.startsWith("@") && entry.isDirectory()) visit(path, true);
      if (!entry.isSymbolicLink() || !existsSync(path)) continue;
      const real = realpathSync(path);
      const store = real.indexOf(`${sep}node_modules${sep}.bun${sep}`);
      if (store >= 0) reads.add(real.slice(0, store + `${sep}node_modules${sep}.bun`.length));
    }
  };
  if (existsSync(modules)) visit(modules, false);
  return [...reads];
}

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
  const wrongStack = (named: unknown) =>
    new Error(
      `The candidate names stack ${String(named)} for this stage, not the lane's ${lane}, so the lane's destroy could not remove what it deploys; nothing is deployed`,
    );
  const file = join(tree, "alchemy.run.ts");
  if (!existsSync(file) || lstatSync(file).isSymbolicLink())
    throw unhandled("no stack file of its own");
  const shape = stackShape(tree, readFileSync(file, "utf8"));
  if (typeof shape === "string") throw unhandled(shape);
  if ("plain" in shape) {
    if (shape.plain !== lane) throw wrongStack(shape.plain);
    throw unhandled("its stack is a plain name, not stackNameForStage's");
  }
  const stack = ownModule(tree, shape.stack);
  if (!stack) throw unhandled("stackNameForStage is not its own tree's");
  const namer = ownModule(tree, shape.namer);
  if (!namer) throw unhandled("no preview names of its own tree for a rehearsal stage");

  const own = realpathSync(tree);
  let answer: { stack?: unknown; disposable?: unknown };
  try {
    answer = withEmptyHome(source, (env) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            // Reads only the tree and its dependencies; no writes, child processes, workers,
            // addons or WASI.
            "--permission",
            `--allow-fs-read=${own}`,
            ...dependencyReads(own).map((path) => `--allow-fs-read=${path}`),
            "--input-type=module",
            "-e",
            probe,
            JSON.stringify([stage, stack, namer]),
          ],
          {
            cwd: own,
            // No stage env and no secrets: naming a stage needs neither.
            env,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 60_000,
          },
        )
          .trim()
          .split("\n")
          .at(-1)!,
      ),
    ) as typeof answer;
  } catch {
    throw unhandled("its stage naming could not be run");
  }
  if (answer.stack !== lane) throw wrongStack(answer.stack);
  if (answer.disposable !== true)
    throw new Error(
      "The candidate takes this stage for production (its preview names do not cover a rehearsal stage), so it would deploy production's names into the lane; nothing is deployed",
    );
}
