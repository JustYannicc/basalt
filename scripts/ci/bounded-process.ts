import { spawn, spawnSync } from "node:child_process";
import { processSnapshot } from "../process-owner.ts";

export type Bounds = {
  deadlineMs: number;
  /** How long stopped or leftover processes get to exit before they are killed. */
  graceMs: number;
  signal?: AbortSignal;
  log: (line: string) => void;
};

/** `leftover`: why something the command started may still be running. */
export type BoundedExit = {
  code: number | null;
  stopped?: "timed-out" | "cancelled";
  leftover?: string;
};

/** How often the tree is listed while it runs, so groups orphaned later can still be found. */
const sampleMs = 5_000;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const signalGroup = (group: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-group, signal);
  } catch (error) {
    // Gone, or only zombies left (macOS refuses those with EPERM): nothing left to signal.
    if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
};

/** Every process group in `root`'s tree. Each member created its group, so all of them are ours. */
function treeGroups(root: number) {
  const listed = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" });
  // An empty list would read as "nothing to stop" and leave detached groups running unseen.
  if (listed.status !== 0)
    throw new Error(
      `ps exited ${listed.status}: ${(listed.stderr || String(listed.error)).trim()}`,
    );
  const rows = listed.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number) as [number, number, number]);
  const tree = new Set([root]);
  for (let grown = true; grown;) {
    grown = false;
    for (const [pid, parent] of rows)
      if (!tree.has(pid) && tree.has(parent)) {
        tree.add(pid);
        grown = true;
      }
  }
  return rows.filter(([pid]) => tree.has(pid)).map(([, , group]) => group);
}

/**
 * Run a command in a process group of its own and return only once nothing it started is left.
 * The e2e suite spawns its servers detached, in further groups, so those are tracked by tree.
 */
export async function runBounded(
  command: string,
  args: readonly string[],
  spawnOptions: { cwd: string; env: NodeJS.ProcessEnv },
  bounds: Bounds,
): Promise<BoundedExit> {
  const child = spawn(command, args, { ...spawnOptions, stdio: "inherit", detached: true });
  const groups = new Set<number>(child.pid === undefined ? [] : [child.pid]);
  let untracked: string | undefined;
  const observe = () => {
    if (child.pid === undefined) return;
    // Only the latest listing counts: one that works again finds every group still in the tree,
    // and what a failed one missed is the same blind spot as the time between two samples.
    try {
      for (const group of treeGroups(child.pid)) groups.add(group);
      untracked = undefined;
    } catch (error) {
      untracked = `could not list its process tree (${(error as Error).message})`;
    }
  };
  const signal = (name: NodeJS.Signals) => groups.forEach((group) => signalGroup(group, name));
  let stopped: BoundedExit["stopped"];
  let stoppedAt: number | undefined;
  let killed = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: NonNullable<BoundedExit["stopped"]>) => {
    if (stopped) return;
    stopped = reason;
    stoppedAt = Date.now();
    observe();
    // SIGTERM lets the suite's finalizers stop servers, remove containers and export evidence.
    signal("SIGTERM");
    escalation = setTimeout(() => {
      observe();
      killed = true;
      signal("SIGKILL");
    }, bounds.graceMs);
  };
  const sampler = setInterval(observe, sampleMs);
  const deadline = setTimeout(() => stop("timed-out"), bounds.deadlineMs);
  const abort = () => stop("cancelled");
  bounds.signal?.addEventListener("abort", abort);
  if (bounds.signal?.aborted) abort();
  const code = await new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      bounds.log(`::error::Could not start ${command}: ${error.message}`);
      resolve(null);
    });
    child.once("exit", (exitCode) => resolve(exitCode));
  });
  clearInterval(sampler);
  clearTimeout(deadline);
  clearTimeout(escalation);
  bounds.signal?.removeEventListener("abort", abort);
  const leftover = (await settle([...groups], stoppedAt, killed, bounds)) ?? untracked;
  return { code, ...(stopped && { stopped }), ...(leftover && { leftover }) };
}

/**
 * Stop what outlived the command, counting the grace from the original stop when there was one.
 * After the deadline's SIGKILL, what is still listed is exiting, not left running: no warning.
 * Returns why something may still be running, if it may.
 */
async function settle(
  groups: number[],
  stoppedAt: number | undefined,
  killed: boolean,
  bounds: Bounds,
) {
  let listed = true;
  const running = () => {
    const snapshot = processSnapshot(groups);
    listed &&= snapshot.complete;
    return !snapshot.complete || snapshot.processes.size > 0;
  };
  if (!running()) return;
  if (!listed && !killed)
    bounds.log("::warning::Cannot list processes; waiting out the grace period");
  if (stoppedAt === undefined) {
    bounds.log("::warning::Stopping processes a declared file left running");
    groups.forEach((group) => signalGroup(group, "SIGTERM"));
    stoppedAt = Date.now();
  }
  if (!killed) {
    while (running() && Date.now() < stoppedAt + bounds.graceMs) await wait(200);
    if (!running()) return;
    bounds.log("::warning::Killing processes a declared file left running");
  }
  groups.forEach((group) => signalGroup(group, "SIGKILL"));
  // The next file must not start while these still hold ports.
  const end = Date.now() + 5_000;
  let left = running();
  while (left && Date.now() < end) {
    await wait(200);
    left = running();
  }
  if (left) return listed ? "some survived SIGKILL" : "could not list its processes";
}
