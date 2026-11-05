import { dlopen, ptr } from "bun:ffi";
import { spawnSync } from "node:child_process";

// Darwin's public proc_bsdinfo ABI provides microsecond starts; ps lstart truncates to seconds.
const { symbols } = dlopen("/usr/lib/libproc.dylib", {
  proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
});
const groups =
  process.argv[2] === "--groups"
    ? new Set((process.argv[3] ?? "").split(",").filter(Boolean).map(Number))
    : undefined;
const target = groups === undefined && process.argv[2] ? Number(process.argv[2]) : undefined;
// Query only lease-bearing groups. Unrelated process churn cannot make their ownership incomplete.
// ps identifies zombies that libproc refuses to read; live entries still require the exact kernel start.
const observed = spawnSync(
  "ps",
  target === undefined
    ? ["-axo", "pid=,pgid=,stat="]
    : ["-p", String(target), "-o", "pid=,pgid=,stat="],
  { encoding: "utf8" },
);
if (observed.status !== 0 && !(target !== undefined && observed.status === 1))
  throw new Error("Cannot enumerate process identities");
const entries = [];
let complete = true;
for (const line of observed.stdout.trim().split("\n").filter(Boolean)) {
  const [id, group, state] = line.trim().split(/\s+/);
  const pid = Number(id);
  if (!Number.isInteger(pid) || !Number.isInteger(Number(group)) || !state)
    throw new Error("Invalid process enumeration");
  if (pid === observed.pid || (groups !== undefined && !groups.has(Number(group)))) continue;
  if (state.startsWith("Z")) {
    entries.push({ pid, group: 0, start: "", zombie: true });
    continue;
  }
  const buffer = Buffer.alloc(136);
  const size = symbols.proc_pidinfo(pid, 3, 0, ptr(buffer), buffer.length);
  if (size === 0) {
    complete = false;
    continue;
  }
  if (size !== buffer.length) throw new Error("Unexpected proc_bsdinfo layout");
  entries.push({
    pid: buffer.readUInt32LE(12),
    group: buffer.readUInt32LE(100),
    start: `${buffer.readBigUInt64LE(120)}:${buffer.readBigUInt64LE(128)}`,
    zombie: buffer.readUInt32LE(4) === 5,
  });
}
console.log(JSON.stringify({ entries, complete }));
