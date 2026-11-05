import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

function readProcesses(
  pid?: number,
  groups?: ReadonlyArray<number>,
): { entries: ProcessEntry[]; complete: boolean } {
  if (process.platform === "darwin") {
    const helper = fileURLToPath(new URL("./process-owner-darwin.mjs", import.meta.url));
    const result = spawnSync(
      "bun",
      [
        helper,
        ...(pid !== undefined
          ? [String(pid)]
          : groups === undefined
            ? []
            : ["--groups", groups.join(",")]),
      ],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (result.status !== 0) throw new Error("Cannot read kernel process identities");
    const response: unknown = JSON.parse(result.stdout);
    if (typeof response !== "object" || response === null)
      throw new Error("Invalid process snapshot");
    const snapshot = response as Record<string, unknown>;
    const entries = snapshot.entries;
    if (
      typeof snapshot.complete !== "boolean" ||
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
        if (gone(error)) return { entries: [], complete: true };
        throw error;
      }
      throw new Error("Cannot verify the identity of an existing process");
    }
    return {
      entries: observed.filter((entry) => !entry.zombie),
      complete: snapshot.complete as boolean,
    };
  }
  if (process.platform !== "linux") throw new Error("Unsupported process identity platform");
  let pids = [pid!];
  if (pid === undefined) {
    const observed = spawnSync("ps", ["-eo", "pid=,pgid=,stat="], { encoding: "utf8" });
    if (observed.status !== 0) throw new Error("Cannot enumerate process identities");
    pids = observed.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const [id, group, state] = line.trim().split(/\s+/);
        if (!Number.isInteger(Number(id)) || !Number.isInteger(Number(group)) || !state)
          throw new Error("Invalid process enumeration");
        return state.startsWith("Z") ||
          Number(id) === observed.pid ||
          (groups !== undefined && !groups.includes(Number(group)))
          ? []
          : [Number(id)];
      });
  }
  let complete = true;
  const entries = pids.flatMap((pid) => {
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
      if (gone(error)) {
        complete = false;
        return [];
      }
      throw error;
    }
  });
  return { entries, complete };
}

export function readProcessOwner(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Expected a positive process number");
  const entry = readProcesses(pid).entries[0];
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

function legacyPid(value: unknown, field = "pid") {
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  const pid = record[field];
  if (Number.isInteger(pid) && Number(pid) > 0) return Number(pid);
}

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (gone(error)) return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

export function processOwnerAlive(value: unknown) {
  if (!isOwner(value)) {
    const pid = legacyPid(value);
    return pid !== undefined && pidAlive(pid);
  }
  if (value.boot !== bootIdentity()) return false;
  return readProcessOwner(value.pid)?.start === value.start;
}

export function processSnapshot(groups?: ReadonlyArray<number>) {
  const boot = bootIdentity();
  if (groups?.length === 0)
    return { boot, complete: true, processes: new Map<number, ProcessEntry>() };
  try {
    const observed = readProcesses(undefined, groups);
    return {
      boot,
      complete: observed.complete,
      processes: new Map(observed.entries.map((entry) => [entry.pid, entry])),
    };
  } catch {
    return { boot, complete: false, processes: new Map<number, ProcessEntry>() };
  }
}

export function installerGroupState(value: unknown) {
  if (!isOwner(value)) return legacyPid(value, "group") === undefined ? "dead" : "unknown";
  if (value.boot !== bootIdentity()) return "dead";
  const lease = value as ProcessOwner & { group?: unknown; token?: unknown };
  if (lease.group !== lease.pid || typeof lease.token !== "string" || !lease.token) return "dead";
  try {
    const leader = readProcesses(lease.pid).entries[0];
    if (!leader) return "unknown";
    return leader.group === lease.group && leader.start === lease.start ? "live" : "dead";
  } catch {
    return "unknown";
  }
}

function inheritedInstallerToken(pid: number, token: string) {
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8")
        .split("\0")
        .includes(`BASALT_DEPENDENCY_INSTALLER=${token}`);
    } catch (error) {
      throw new Error("Cannot verify a surviving installer child", { cause: error });
    }
  }
  const result = spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error("Cannot verify a surviving installer child");
  // Keep the environment private. Only membership in this exact installer incarnation escapes this function.
  return result.stdout.split(/\s+/).includes(`BASALT_DEPENDENCY_INSTALLER=${token}`);
}

export function installerGroupAlive(value: unknown, snapshot: ReturnType<typeof processSnapshot>) {
  if (!snapshot.complete) return true;
  if (!isOwner(value)) {
    const group = legacyPid(value, "group");
    return (
      group !== undefined && [...snapshot.processes.values()].some((entry) => entry.group === group)
    );
  }
  if (value.boot !== snapshot.boot) return false;
  const lease = value as ProcessOwner & { group?: unknown; token?: unknown };
  if (lease.group !== lease.pid || typeof lease.token !== "string" || !lease.token) return false;
  const leader = snapshot.processes.get(lease.pid) ?? readProcesses(lease.pid).entries[0];
  if (leader) return leader.group === lease.group && leader.start === lease.start;
  // A group can outlive its leader. The inherited nonce distinguishes it from a later leaderless group with a recycled PGID.
  const token = lease.token;
  return [...snapshot.processes.values()].some(
    (entry) => entry.group === lease.group && inheritedInstallerToken(entry.pid, token),
  );
}
