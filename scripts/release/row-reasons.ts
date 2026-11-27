import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { dotAlchemyDirectory } from "alchemy/AlchemyContext";
import { ArtifactStore } from "alchemy/Artifacts";
import * as Cloudflare from "alchemy/Cloudflare";
import { hashDirectory, type MemoOptions } from "alchemy/Command/Memo";
import type * as AlchemyPlan from "alchemy/Plan";
import { initialCwd } from "alchemy/Util/Node";
import { Context, Effect, Option } from "effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import {
  changedFiles,
  deployedCommit,
  perReleaseFiles,
  type ChangedFiles,
} from "./changed-files.ts";

/**
 * Why a planned row plans, past what the plan itself says: which changed files are among a
 * command's key files, which reach a Worker's bundle, and which hash a Worker the provider alone
 * changes differs in. Every value is read from the plan, the plan's own artifacts (each Worker's
 * bundle, built while the plan diffed it) and the files on disk, by Alchemy's own functions. It
 * only reads: nothing in the plan, its rows or its digest depends on it.
 *
 * Only repository paths are printed, and only changed ones; files a hash covers are counted.
 */

/** What every read here needs: the plan's file system and paths. */
export type Reads = FileSystem.FileSystem | Path.Path;

export interface ReasonRow {
  readonly fqn: string;
  readonly type: string;
  readonly action: string;
  readonly changedProps: readonly string[];
  readonly bindings: readonly unknown[];
}

export interface ReasonInput {
  readonly plan: AlchemyPlan.Plan;
  /** The plan's changed rows (`changedRows`). */
  readonly rows: readonly ReasonRow[];
  /** The repository checkout; its prepared tree is `.upstream`. */
  readonly root: string;
  readonly changed: ChangedFiles | undefined;
  /** The plan's artifact store, by FQN: what each provider computed while it diffed. */
  readonly artifacts: ReadonlyMap<string, ReadonlyMap<string, unknown>> | undefined;
  /** Runs a read in the plan's own services: its file system and `.alchemy` directory. */
  readonly provide: <A, E>(effect: Effect.Effect<A, E, Reads>) => Effect.Effect<A, E, never>;
}

const LISTED = 10;
const listed = (names: readonly string[]) =>
  names.length <= LISTED
    ? names.join(", ")
    : `${names.slice(0, LISTED).join(", ")} and ${names.length - LISTED} more`;
/** A hash slot's value, shortened; anything that is not a hash is never printed. */
const short = (value: unknown) =>
  typeof value !== "string"
    ? "none"
    : /^[0-9a-f]{12,}$/u.test(value)
      ? value.slice(0, 12)
      : "not a hash";
const posix = (file: string) => file.split(path.sep).join("/");
const stamps = new Set(perReleaseFiles);
/**
 * Files that change a bundle without being one of its sources: the dependencies the bundler
 * resolves from the package store, and the build's own configuration. A source map never names them.
 */
const buildInput = (file: string) =>
  /(^|\/)(bun\.lockb?|package\.json|upstream\.json|tsconfig[^/]*\.json|alchemy\.run\.[^/]+|(vite|rolldown)\.config\.[^/]+)$/u.test(
    file,
  );

/** The repository path of a file on disk: under the checkout, or `.upstream/…` in its prepared tree. */
const repoPaths = (root: string) => {
  const real = (dir: string) => {
    try {
      return realpathSync(dir);
    } catch {
      return dir;
    }
  };
  const upstream = path.join(root, ".upstream");
  const bases = [
    [real(upstream), ".upstream"],
    [upstream, ".upstream"],
    [real(root), ""],
    [root, ""],
  ] as const;
  return (file: string) => {
    for (const [base, name] of bases) {
      const relative = path.relative(base, file);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative))
        return path.posix.join(name, posix(relative));
    }
    return undefined;
  };
};

/** Runs an Alchemy read, recording every file it reads whole: the files a hash covers. */
const reading = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = new Set<string>();
    const value = yield* effect.pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readFile: (file: string) => {
          files.add(file);
          return fs.readFile(file);
        },
      }),
    );
    return { value, files: [...files].sort() };
  });

interface Bundle {
  readonly hash: string;
  readonly files: readonly { readonly path: string; readonly content: string | Uint8Array }[];
}
const isBundle = (value: unknown): value is Bundle =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { hash?: unknown }).hash === "string" &&
  Array.isArray((value as { files?: unknown }).files);

/** The files a bundle's source maps name, on disk: the map's sources from its own folder. */
const bundleSources = (bundle: Bundle, folder: string) =>
  bundle.files
    .filter((file) => file.path.endsWith(".map"))
    .flatMap((file) => {
      const map = JSON.parse(
        typeof file.content === "string" ? file.content : new TextDecoder().decode(file.content),
      ) as { sources?: unknown; sourceRoot?: unknown };
      const base = path.resolve(
        folder,
        path.dirname(file.path),
        typeof map.sourceRoot === "string" ? map.sourceRoot : "",
      );
      return Array.isArray(map.sources)
        ? map.sources
            .filter((source): source is string => typeof source === "string")
            .map((source) => path.resolve(base, source))
        : [];
    });

/** The one function of Alchemy's Vite source read here. */
interface ViteSource {
  readonly hashViteInput: (
    rootDir: string | undefined,
    memo: unknown,
    workspaces: Effect.Effect<Iterable<string>>,
  ) => Effect.Effect<{ readonly hash: string }, PlatformError, Reads>;
}
/** Alchemy's Vite source, which its package does not export; its Worker provider loads it lazily too. */
const loadVite = async () => {
  // Bun resolves to the package's sources and Node to its build; either may return a path.
  const resolved = import.meta.resolve("alchemy/Cloudflare");
  const cloudflare = resolved.startsWith("file:") ? new URL(resolved) : pathToFileURL(resolved);
  const extension = path.extname(cloudflare.pathname);
  return (await import(
    new URL(`./Workers/Sources/Vite${extension}`, cloudflare).href
  )) as ViteSource;
};

interface WorkerProps {
  readonly main?: string;
  readonly script?: string;
  readonly source?: unknown;
  readonly vite?: { readonly rootDir?: string; readonly memo?: unknown };
  readonly assets?: string | { readonly directory?: string; readonly hash?: unknown };
}

export async function rowReasons(input: ReasonInput): Promise<string[]> {
  const run = <A, E>(effect: Effect.Effect<A, E, Reads>) =>
    Effect.runPromise(input.provide(effect));
  const { changed } = input;
  const repoPath = repoPaths(input.root);
  const changedPaths = (files: readonly string[]) =>
    [
      ...new Set(
        files.flatMap((file) => {
          const name = repoPath(file);
          return name !== undefined && changed?.files.has(name) ? [name] : [];
        }),
      ),
    ].sort();
  const dotAlchemy = path.resolve(initialCwd, await run(dotAlchemyDirectory));

  const commandLines = async (row: ReasonRow, props: { cwd?: string; memo?: unknown }) => {
    if (props.memo === false) return [`${row.fqn}: runs on every release; it has no key files`];
    // Its diff stops at these before it hashes any file, so the key files are not why it plans.
    if (row.action === "create") return [`${row.fqn}: new, so it runs`];
    if (row.changedProps.length) return [];
    if (!changed) return [];
    // The command's key as its diff hashes it (Command/Exec.ts): every file it reads whole.
    const { files } = await run(
      reading(
        hashDirectory({
          cwd: props.cwd,
          memo: (props.memo === true ? {} : props.memo) as MemoOptions | undefined,
        }),
      ),
    );
    const hit = changedPaths(files);
    return [
      hit.length
        ? `${row.fqn}: key files changed: ${listed(hit)} (${hit.length} of ${files.length} key files)`
        : `${row.fqn}: no key file changed (${files.length} key files)` +
          (row.type === "Command.Build"
            ? "; a build also plans when its output hash differs, which this entry does not compare"
            : ""),
    ];
  };

  const workerLines = async (row: ReasonRow, node: AlchemyPlan.Plan["resources"][string]) => {
    const built = input.artifacts?.get(row.fqn)?.get("build");
    const bundle = isBundle(built) ? built : undefined;
    const lines: string[] = [];
    if (changed) {
      const id = (node as { resource?: { LogicalId?: string } }).resource?.LogicalId ?? row.fqn;
      // The folder the bundler writes it to (Workers/Sources/Rolldown.ts), which its map is relative to.
      const sources = bundle
        ? bundleSources(bundle, path.join(dotAlchemy, "bundles", id)).filter((file) =>
            existsSync(file),
          )
        : [];
      const touched = changedPaths(sources);
      const reached = touched.filter((file) => !stamps.has(file));
      // Every release rewrites these, so a Worker that reaches one always changes; listed apart.
      const stamped = touched.length > reached.length ? ", plus the per-release stamp" : "";
      // Only inputs that can bear on this Worker: at a root, or in a folder its sources sit under.
      const sourcePaths = sources.flatMap((file) => repoPath(file) ?? []);
      const inputs = [...changed.files]
        .filter((file) => {
          if (!buildInput(file)) return false;
          const folder = path.posix.dirname(file);
          return (
            folder === "." ||
            folder === ".upstream" ||
            sourcePaths.some((source) => source.startsWith(`${folder}/`))
          );
        })
        .sort();
      const configured = inputs.length
        ? `; dependencies or build configuration changed: ${listed(inputs)}`
        : "";
      const vite = Boolean(("props" in node ? (node.props as WorkerProps) : {}).vite);
      lines.push(
        !bundle
          ? `${row.fqn}: ${vite ? "a vite Worker is not built at plan time" : "the plan built no bundle for it"}, so which changed files reach it is not known`
          : !sources.length
            ? `${row.fqn}: its bundle's source map names no file in this checkout, so which changed files reach it is not known`
            : reached.length
              ? `${row.fqn}: ${reached.length} changed ${reached.length === 1 ? "file reaches" : "files reach"} this Worker: ${listed(reached)}${stamped}`
              : stamped
                ? `${row.fqn}: only the per-release stamp reaches this Worker${configured}`
                : inputs.length
                  ? `${row.fqn}: no changed source file reaches this Worker${configured}`
                  : `${row.fqn}: no changed file reaches this Worker`,
      );
    }
    if (row.action === "update" && !row.changedProps.length && !row.bindings.length)
      lines.push(`${row.fqn}: ${await providerDiff(node, bundle, run)}`);
    return lines;
  };

  const lines = [
    changed
      ? `Changed files since the deployed commit ${changed.deployed.slice(0, 12)}: ${changed.files.size}` +
        (changed.upstreamPin
          ? "; the upstream pin moved too, so prepared files no changed carry names can differ as well"
          : "")
      : "Changed files unknown: State records no one deployed commit, an apply left a row unfinished, or this checkout does not hold the commit, so no row names a file",
  ];
  for (const row of input.rows) {
    const node = input.plan.resources[row.fqn];
    if (!node || !("props" in node)) continue;
    try {
      if (row.type.startsWith("Command.") && row.action !== "noop")
        lines.push(...(await commandLines(row, (node.props ?? {}) as never)));
      else if (row.type === "Cloudflare.Worker" && ["update", "replace"].includes(row.action))
        lines.push(...(await workerLines(row, node)));
    } catch {
      // Its error can carry a path or a value; the line names the row only.
      lines.push(`${row.fqn}: why it plans could not be read`);
    }
  }
  return lines;
}

/**
 * Which hash a Worker the provider alone changes differs in, State's value and the plan's, in the
 * order the provider's diff compares them (Workers/WorkerProvider.ts `hasChanged`).
 */
async function providerDiff(
  node: AlchemyPlan.Plan["resources"][string],
  bundle: Bundle | undefined,
  run: <A, E>(effect: Effect.Effect<A, E, Reads>) => Promise<A>,
) {
  const props = ("props" in node ? node.props : {}) as WorkerProps;
  const recorded =
    (node.state as { attr?: { hash?: Record<string, unknown> } } | undefined)?.attr?.hash ?? {};
  const differs: string[] = [];
  const compare = (slot: string, computed: unknown, more = "") => {
    if (computed !== recorded[slot])
      differs.push(
        `${slot} differs: State ${short(recorded[slot])}, computed ${short(computed)}${more}`,
      );
  };
  if (props.source)
    return "planned by the provider's own diff; an external source computes its hashes, which this entry does not compare";
  if (props.script !== undefined)
    return "planned by the provider's own diff; an inline script's hash is not compared here";
  if (props.vite) {
    const Vite = await loadVite();
    const workspaces = recorded.additionalWorkspaces;
    const { value, files } = await run(
      reading(
        Vite.hashViteInput(
          props.vite.rootDir,
          props.vite.memo,
          Effect.succeed(Array.isArray(workspaces) ? (workspaces as string[]) : []),
        ),
      ),
    );
    // Counted only: the files are the release tree's, and the log is public.
    compare("input", value.hash, `, over ${files.length} files`);
  } else if (props.main !== undefined) {
    if (bundle) compare("bundle", bundle.hash);
    else
      differs.push(
        `the plan built no bundle, so its diff stopped before the code: its metadata hash differs, or the row predates the stored Worker id (State metadata ${short(recorded.metadata)})`,
      );
  } else if (recorded.bundle !== undefined) {
    differs.push("it no longer has an entry file, while State still records a bundle");
  }
  if (props.assets && !props.vite) {
    const { assets } = props;
    const computed =
      typeof assets === "object" && assets.hash !== undefined
        ? assets.hash
        : typeof assets === "object" && assets.directory === undefined
          ? null
          : await run(
              Cloudflare.Workers.readAssets(
                // As the provider reads it: a hash-less shape without its `hash` key.
                typeof assets === "string"
                  ? { directory: assets }
                  : (Object.fromEntries(
                      Object.entries(assets).filter(([key]) => key !== "hash"),
                    ) as unknown as Cloudflare.Workers.AssetsProps),
              ).pipe(
                Effect.map((read) => read.hash),
                Effect.orElseSucceed(() => null),
              ),
            );
    if (computed === null || computed === undefined)
      // The provider counts assets it cannot read as changed.
      differs.push(
        `assets not readable here, which the provider counts as changed (State ${short(recorded.assets)})`,
      );
    // A hash another row's build supplies is not known until that build runs.
    else if (typeof computed !== "string")
      differs.push(
        `assets not known until the build it reads resolves (State ${short(recorded.assets)})`,
      );
    else compare("assets", computed);
  }
  return differs.length
    ? `planned by the provider's own diff: ${differs.join("; ")}`
    : "planned by the provider's own diff, but no hash this entry computes (input, bundle, assets) differs from State's; the metadata hash is not compared";
}

/** A deploy waits on these between its digest and its apply, so they get a bound. */
export const REASONS_TIMEOUT_MS = 60_000;

/** The printed lines; a failure or a stall reading them never changes the plan's outcome. */
export const reasonLines = (input: ReasonInput, timeoutMs = REASONS_TIMEOUT_MS) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<string[]>((resolve) => {
    timer = setTimeout(
      () =>
        resolve([
          `Why these rows plan: not read within ${timeoutMs / 1000} s; the plan is unaffected`,
        ]),
      timeoutMs,
    );
  });
  const read = rowReasons(input).catch(() => [
    "Why these rows plan: could not be read for this plan; the plan is unaffected",
  ]);
  return Promise.race([read, stalled]).finally(() => clearTimeout(timer));
};

/**
 * The lines for a plan Alchemy's `Stack.plan` returned: the deployed commit from its State rows,
 * the changed files from the checkout, and the bundles from its session's artifact store. Read
 * after the digest is printed; nothing the deploy compares reads them.
 */
export function planReasonLines(options: {
  readonly snapshot: {
    readonly native: AlchemyPlan.Plan;
    readonly session?: { readonly context: Context.Context<never> };
  };
  readonly rows: readonly ReasonRow[];
  readonly root: string;
  readonly candidate: string;
  readonly timeoutMs?: number;
}) {
  const { snapshot } = options;
  const context = snapshot.session?.context;
  let changed: ChangedFiles | undefined;
  try {
    changed = changedFiles(options.root, deployedCommit(snapshot.native), options.candidate);
  } catch {
    changed = undefined;
  }
  return reasonLines(
    {
      plan: snapshot.native,
      rows: options.rows,
      root: options.root,
      changed,
      artifacts: context
        ? Option.getOrUndefined(
            Context.getOption(context as Context.Context<ArtifactStore>, ArtifactStore),
          )
        : undefined,
      // A plan's session holds the services its own diff read the same files with.
      provide: (effect) =>
        Effect.provide(effect, (context ?? Context.empty()) as Context.Context<Reads>),
    },
    options.timeoutMs,
  );
}
