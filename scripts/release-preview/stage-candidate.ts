/**
 * Whether a candidate tree may release onto a stage the harness tree runs: its own pin, framework
 * build and served version, its own guard tests on a moved pin, and a State decoder the harness
 * shares, so the harness can still read and tear down what the candidate released.
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The only stage-env keys a candidate tree replaces. Everything naming the stage (its stage,
 * database, origin and secrets) still comes from the harness's `stageEnvironment` for this lane.
 */
const candidateTreeKeys = [
  "EXECUTOR_BUILD_VERSION",
  "EXECUTOR_APPS_VERSION",
  "EXECUTOR_APPS_FRAMEWORK",
] as const;

const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

/**
 * The stage env names the harness tree's upstream pin, served framework version and framework
 * build. A candidate tree releases on its own three instead, and only when it built them itself:
 * its `.upstream` checkout sits at its own pin and its framework build declares its own version.
 */
export function candidateTreeEnvironment(
  harness: string,
  tree: string,
): Partial<Record<(typeof candidateTreeKeys)[number], string>> {
  if (tree === harness) return {};
  const refusal = (why: string) => new Error(`The candidate tree ${why}; nothing runs on it`);
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
  const parse = (text: string | undefined): unknown => {
    try {
      return text === undefined ? undefined : JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  const pin = (parse(read(join(tree, "upstream.json"))) as { commit?: unknown } | undefined)
    ?.commit;
  if (typeof pin !== "string" || !/^[a-f0-9]{40}$/u.test(pin))
    throw refusal("names no upstream commit in upstream.json");
  const upstream = join(tree, ".upstream");
  // A link would let `git -C` and `realpath` both read another tree's checkout and build as its own.
  if (lstatSync(upstream, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error(
      "The candidate tree's prepared upstream must not be a symbolic link; nothing runs on it",
    );
  // Its own checkout, not the candidate's repository seen from a plain directory inside it.
  const git = (...args: string[]) => {
    try {
      return execFileSync("git", ["-C", upstream, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return undefined;
    }
  };
  const top = git("rev-parse", "--show-toplevel");
  if (!top || !existsSync(upstream) || realpathSync(top) !== realpathSync(upstream))
    throw refusal("has no prepared upstream checkout");
  if (git("rev-parse", "HEAD") !== pin) throw refusal("has an upstream checkout off its own pin");

  // Read as text, so a module that only computes its version yields none; the build's recorded
  // version below must still match it.
  const versions = [
    ...(read(join(tree, "framework-release.ts")) ?? "").matchAll(
      /^export const servedFrameworkVersion = "([0-9A-Za-z.+-]{1,80})";$/gmu,
    ),
  ];
  const version = versions.length === 1 ? versions[0]![1] : undefined;
  if (!version) throw refusal("serves no framework version in framework-release.ts");

  // The build records its version (package.json, runtime.json) but not the pin it built from;
  // the checkout's HEAD above stands for that.
  const framework = join(upstream, ".local/basalt-framework");
  // Like `.upstream` itself: a link, here or above it, would hand over another tree's build.
  if (
    lstatSync(framework, { throwIfNoEntry: false })?.isSymbolicLink() ||
    (existsSync(framework) && !inside(realpathSync(upstream), realpathSync(framework)))
  )
    throw new Error(
      "The candidate tree's framework build must be its own, not a symbolic link; nothing runs on it",
    );
  const files = parse(read(join(framework, "framework.json"))) as
    | Record<string, unknown>
    | undefined;
  const built = (name: string) =>
    (
      parse(typeof files?.[name] === "string" ? files[name] : undefined) as
        | { version?: unknown }
        | undefined
    )?.version;
  if (!files) throw refusal("has no framework build");
  if (built("package.json") !== version || built("runtime.json") !== version)
    throw refusal("has a framework build of another version");

  return {
    EXECUTOR_BUILD_VERSION: pin,
    EXECUTOR_APPS_VERSION: version,
    EXECUTOR_APPS_FRAMEWORK: framework,
  };
}

/** The upstream commit a tree's upstream.json names, if it names one. */
function upstreamPin(tree: string) {
  try {
    const commit = (
      JSON.parse(readFileSync(join(tree, "upstream.json"), "utf8")) as { commit?: unknown }
    ).commit;
    return typeof commit === "string" ? commit : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a candidate tree releases on another upstream pin than the harness's. */
export const pinMoved = (harness: string, tree: string) =>
  tree !== harness && upstreamPin(tree) !== upstreamPin(harness);

/**
 * How a prepared tree's cloud app decodes State, per package: the installed version, the bun store
 * entry it resolves to (`<name>@<version>[+<hash>]`), and the bytes of the upstream patch for that
 * version, or null when there is none. Upstream patches alchemy, so a pin that changes only the
 * patch keeps the version. Undefined when any of it cannot be read.
 */
function stateDecoder(tree: string) {
  return ["alchemy", "effect"].map((name) => {
    try {
      const file = join(tree, ".upstream/apps/hosted/cloud/node_modules", name, "package.json");
      const version = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
      if (typeof version !== "string" || version === "") return undefined;
      const store = [
        ...realpathSync(file).matchAll(/[\\/]node_modules[\\/]\.bun[\\/]([^\\/]+)[\\/]/gu),
      ].at(-1)?.[1];
      if (!store) return undefined;
      const patch = join(tree, ".upstream/patches", `${name}@${version}.patch`);
      return {
        version,
        store,
        patch: existsSync(patch) ? readFileSync(patch).toString("base64") : null,
      };
    } catch {
      return undefined;
    }
  });
}

/**
 * Whether two prepared trees decode State the same: the cloud app resolves the same alchemy and
 * effect, by version, bun store entry and upstream patch. Unreadable on either side is not the same.
 */
export const sameStateDecoder = (harness: string, tree: string) => {
  const [a, b] = [stateDecoder(harness), stateDecoder(tree)];
  return a.every((mine, index) => {
    const theirs = b[index];
    return (
      mine !== undefined &&
      theirs !== undefined &&
      mine.version === theirs.version &&
      mine.store === theirs.store &&
      mine.patch === theirs.patch
    );
  });
};

/**
 * On a moved pin the harness reads the stage's boot and tears it down with its own alchemy and
 * effect, so a candidate that decodes State otherwise is refused before anything deploys.
 */
export function requireSameStateDecoder(harness: string, tree: string) {
  if (pinMoved(harness, tree) && !sameStateDecoder(harness, tree))
    throw new Error(
      "The candidate's alchemy or effect build differs from the harness's, so the harness could neither read the stage's boot after the release nor tear it down safely; nothing is deployed",
    );
}

/**
 * Tests that ran in a TAP stream from `node --test`: not suites, not skipped or todo, and not the
 * placeholder node reports for a file it ran that held no tests (named by the file, typed a test).
 */
export function testsRan(tap: string, files: readonly string[]) {
  let count = 0;
  let counts: boolean | undefined;
  for (const line of tap.split(/\r?\n/u)) {
    const ok = /^\s*(?:not )?ok \d+ - (.*?)(?: # (?:SKIP|TODO)\b.*)?$/u.exec(line);
    if (ok) {
      counts = !/ # (?:SKIP|TODO)\b/u.test(line) && !files.includes(ok[1]!);
      continue;
    }
    const type = /^\s*type: '(\w+)'$/u.exec(line);
    if (type && counts !== undefined) {
      if (counts && type[1] === "test") count += 1;
      counts = undefined;
    }
  }
  return count;
}

/** Past this the guard child and every test process it started are killed. */
const guardDeadlineMs = 10 * 60_000;

const guardRuns = new Map<string, Promise<void>>();

/**
 * On another upstream pin, the candidate's release guard runs on alchemy and effect versions nobody
 * reviewed with it, so its own guard tests run in its tree first: once per tree and pin in a run,
 * output kept in the private outputs. On the harness's pin nothing changed, so nothing runs.
 */
export function requireCandidateGuard(
  harness: string,
  tree: string,
  outputs: string,
  source: NodeJS.ProcessEnv = process.env,
) {
  if (!pinMoved(harness, tree)) return Promise.resolve();
  const pin = upstreamPin(tree) ?? "none";
  const head = (() => {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: tree,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "none";
    }
  })();
  const key = `${resolve(tree)}\0${head}\0${pin}`;
  const known = guardRuns.get(key);
  if (known) return known;
  const run = (async () => {
    const dir = join(tree, "scripts/release");
    const files = (existsSync(dir) ? readdirSync(dir) : [])
      .filter(
        (name) => /^wire-guard.*\.test\.ts$/u.test(name) || name === "state-store-guard.test.ts",
      )
      .sort()
      .map((name) => join("scripts/release", name));
    if (!files.length)
      throw new Error(
        "The candidate tree has no guard tests to re-prove on its upstream pin; nothing runs on it",
      );
    await mkdir(outputs, { recursive: true, mode: 0o700 });
    const log = join(outputs, `candidate-guard-${pin.slice(0, 12)}.txt`);
    await writeFile(log, "", { mode: 0o600 });
    let tap = "";
    const { code, timedOut } = await new Promise<{ code: number; timedOut: boolean }>((done) => {
      // No stage env and no secrets: the guard tests need neither.
      const child = spawn(
        process.execPath,
        [
          "--test",
          "--test-reporter=tap",
          "--test-reporter-destination=stdout",
          `--test-timeout=${guardDeadlineMs - 60_000}`,
          ...files,
        ],
        {
          cwd: tree,
          env: { PATH: source.PATH, HOME: source.HOME, TMPDIR: source.TMPDIR },
          stdio: ["ignore", "pipe", "pipe"],
          // Its own process group, so the deadline kills the test processes it started too.
          detached: true,
        },
      );
      let timedOut = false;
      const deadline = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, guardDeadlineMs);
      const keep = (chunk: Buffer) => void appendFile(log, chunk, { mode: 0o600 });
      child.stdout.on("data", (chunk: Buffer) => {
        tap += chunk.toString("utf8");
        keep(chunk);
      });
      child.stderr.on("data", keep);
      child.once("error", () => {
        clearTimeout(deadline);
        done({ code: 1, timedOut });
      });
      child.once("close", (status) => {
        clearTimeout(deadline);
        done({ code: status ?? 1, timedOut });
      });
    });
    if (timedOut)
      throw new Error(
        `The candidate tree's own guard tests did not finish within ${guardDeadlineMs / 60_000} minutes on its upstream pin (output in the private outputs); nothing runs on it`,
      );
    if (code !== 0)
      throw new Error(
        `The candidate tree's own guard tests failed on its upstream pin (exit ${code}, output in the private outputs); nothing runs on it`,
      );
    // `node --test` exits 0 when nothing ran, so a passing exit alone proves no guard.
    if (testsRan(tap, files) === 0)
      throw new Error(
        "The candidate tree's own guard tests ran no tests on its upstream pin; nothing runs on it",
      );
  })();
  guardRuns.set(key, run);
  return run;
}
