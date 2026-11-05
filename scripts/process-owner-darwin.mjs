import { dlopen, ptr } from "bun:ffi";

// Darwin's public proc_bsdinfo ABI provides microsecond starts; ps lstart truncates to seconds.
const { symbols } = dlopen("/usr/lib/libproc.dylib", {
  proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
  proc_listallpids: { args: ["ptr", "i32"], returns: "i32" },
});
let pids;
if (process.argv[2]) pids = [Number(process.argv[2])];
else {
  let capacity = symbols.proc_listallpids(null, 0) + 128;
  while (true) {
    const buffer = Buffer.alloc(capacity * 4);
    const count = symbols.proc_listallpids(ptr(buffer), buffer.length);
    if (count <= 0) throw new Error("Cannot enumerate process identities");
    if (count === capacity) {
      capacity *= 2;
      continue;
    }
    pids = Array.from({ length: count }, (_, index) => buffer.readUInt32LE(index * 4));
    break;
  }
}
const entries = [];
for (const pid of pids) {
  const buffer = Buffer.alloc(136);
  const size = symbols.proc_pidinfo(pid, 3, 0, ptr(buffer), buffer.length);
  if (size === 0) continue;
  if (size !== buffer.length) throw new Error("Unexpected proc_bsdinfo layout");
  entries.push({
    pid: buffer.readUInt32LE(12),
    group: buffer.readUInt32LE(100),
    start: `${buffer.readBigUInt64LE(120)}:${buffer.readBigUInt64LE(128)}`,
    zombie: buffer.readUInt32LE(4) === 5,
  });
}
console.log(JSON.stringify(entries));
