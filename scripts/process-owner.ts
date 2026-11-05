import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

type ProcessEntry = { pid: number; group: number; start: string; zombie?: boolean };
export type ProcessOwner = { pid: number; boot: string; start: string };
let boot: string | undefined;
let owner: ProcessOwner | undefined;

export function bootIdentity() {
  if (boot !== undefined) return boot;
  let observed: string;
  if (process.platform === "linux")
    observed = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  else if (process.platform === "darwin") {
    const result = spawnSync("sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" });
    if (result.status !== 0) throw new Error("Cannot read the boot identity");
    observed = result.stdout.trim();
  } else throw new Error("Dependency process ownership requires Linux or macOS");
  if (!observed) throw new Error("The boot identity is empty");
  boot = observed;
  return boot;
}

function gone(error: unknown) {
  return ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "");
}

function readProcesses(pid?: number): ProcessEntry[] {
  if (process.platform === "darwin") {
    const helper = fileURLToPath(new URL("./process-owner-darwin.mjs", import.meta.url));
    const result = spawnSync("bun", [helper, ...(pid === undefined ? [] : [String(pid)])], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error("Cannot read kernel process identities");
    const entries: unknown = JSON.parse(result.stdout);
    if (
      !Array.isArray(entries) ||
      entries.some((entry: unknown) => {
        if (typeof entry !== "object" || entry === null) return true;
        const value = entry as Record<string, unknown>;
        return (
          !Number.isInteger(value.pid) ||
          !Number.isInteger(value.group) ||
          typeof value.start !== "string"
        );
      })
    )
      throw new Error("Invalid kernel process identities");
    const observed = entries as ProcessEntry[];
    if (pid !== undefined && !observed.some((entry) => entry.pid === pid)) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (gone(error)) return [];
        throw error;
      }
      throw new Error("Cannot verify the identity of an existing process");
    }
    return observed.filter((entry) => !entry.zombie);
  }
  if (process.platform !== "linux") throw new Error("Unsupported process identity platform");
  const pids =
    pid === undefined
      ? readdirSync("/proc")
          .filter((name) => /^\d+$/.test(name))
          .map(Number)
      : [pid];
  return pids.flatMap((pid) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm is parenthesized and may itself contain spaces or closing parentheses.
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      if (fields[0] === "Z") return [];
      return [{ pid, group: Number(fields[2]), start: fields[19]! }];
    } catch (error) {
      if (gone(error)) return [];
      throw error;
    }
  });
}

export function readProcessOwner(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Expected a positive process number");
  const entry = readProcesses(pid)[0];
  return entry && { pid: entry.pid, boot: bootIdentity(), start: entry.start };
}

export function currentProcessOwner() {
  owner ??= readProcessOwner(process.pid);
  if (!owner) throw new Error("Cannot identify the preparing process");
  return owner;
}

function isOwner(value: unknown): value is ProcessOwner {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record.pid) &&
    Number(record.pid) > 0 &&
    typeof record.boot === "string" &&
    typeof record.start === "string"
  );
}

export function processOwnerAlive(value: unknown) {
  if (!isOwner(value) || value.boot !== bootIdentity()) return false;
  return readProcessOwner(value.pid)?.start === value.start;
}

export const processSnapshot = () => ({
  boot: bootIdentity(),
  processes: new Map(readProcesses().map((entry) => [entry.pid, entry])),
});

export function ownerInSnapshot(value: unknown, snapshot: ReturnType<typeof processSnapshot>) {
  return (
    isOwner(value) &&
    value.boot === snapshot.boot &&
    (snapshot.processes.get(value.pid)?.start ?? readProcessOwner(value.pid)?.start) === value.start
  );
}

function inheritedInstallerToken(pid: number, token: string) {
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8")
        .split("\0")
        .includes(`BASALT_DEPENDENCY_INSTALLER=${token}`);
    } catch (error) {
      if (gone(error)) return false;
      throw error;
    }
  }
  const result = spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  if (result.status === 1) return false;
  if (result.status !== 0) throw new Error("Cannot verify a surviving installer child");
  // Keep the environment private. Only membership in this exact installer incarnation escapes this function.
  return result.stdout.split(/\s+/).includes(`BASALT_DEPENDENCY_INSTALLER=${token}`);
}

export function installerGroupAlive(value: unknown, snapshot: ReturnType<typeof processSnapshot>) {
  if (!isOwner(value) || value.boot !== snapshot.boot) return false;
  const lease = value as ProcessOwner & { group?: unknown; token?: unknown };
  if (lease.group !== lease.pid || typeof lease.token !== "string" || !lease.token) return false;
  const leader = snapshot.processes.get(lease.pid) ?? readProcesses(lease.pid)[0];
  if (leader) return leader.group === lease.group && leader.start === lease.start;
  // A group can outlive its leader. The inherited nonce distinguishes it from a later leaderless group with a recycled PGID.
  const token = lease.token;
  return [...snapshot.processes.values()].some(
    (entry) => entry.group === lease.group && inheritedInstallerToken(entry.pid, token),
  );
}
