import { mkdir, readFile, lstat, writeFile, rename, unlink, rmdir, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { apply, clientEntries, markToml, remove } from "./config.mjs";

async function read(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Config paths must be regular files.");
    return { bytes: (await readFile(path)).toString("base64"), mode: stat.mode & 0o777 };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function atomic(path, snapshot) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (snapshot === null) { await unlink(path).catch((error) => { if (error.code !== "ENOENT") throw error; }); return; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, Buffer.from(snapshot.bytes, "base64"), { mode: snapshot.mode, flag: "wx" });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}
const snapshot = (source, mode = 0o600) => ({ bytes: Buffer.from(source).toString("base64"), mode });

export function configPaths(home, env) {
  const claude = resolve(env.CLAUDE_CONFIG_DIR || join(home, ".claude"));
  const codex = resolve(env.CODEX_HOME || join(home, ".codex"));
  return [
    { kind: "claude", path: join(claude, "settings.json"), format: "json" },
    { kind: "claudeMcp", path: env.CLAUDE_CONFIG_DIR ? join(claude, ".claude.json") : join(home, ".claude.json"), format: "json" },
    { kind: "codex", path: join(codex, "config.toml"), format: "toml" },
  ];
}

/** Backups are committed before any config write. An interrupted write is recoverable by undo. */
export async function configure({ home, env = {}, brand, credentials, undo = false }) {
  const directory = join(home, ".local", "state", brand.setup.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lock = join(directory, "lock");
  try { await mkdir(lock); } catch { throw new Error("Setup is already running. If it was interrupted, remove its setup lock and run undo."); }
  const manifestPath = join(directory, "backups.json");
  try {
    const manifestBytes = await read(manifestPath);
    const previous = manifestBytes ? JSON.parse(Buffer.from(manifestBytes.bytes, "base64").toString()) : null;
    if (previous && previous.id !== brand.setup.id) throw new Error("The backup belongs to another setup.");
    const paths = configPaths(home, env);
    if (previous && !previous.files.every((file) => paths.some((target) => target.path === file.path)))
      throw new Error("Config directories changed. Run undo using the original directories first.");
    if (undo) {
      if (!previous) return;
      // Parse everything before touching any file.
      const restores = await Promise.all(previous.files.map(async (file) => {
        const current = await read(file.path);
        if (current?.bytes === file.before?.bytes) return { path: file.path, skip: true };
        if (current?.bytes === file.after.bytes || current?.bytes === file.input?.bytes) return { path: file.path, restore: file.before };
        if (!current) return { path: file.path, skip: true };
        return { path: file.path, restore: snapshot(remove(Buffer.from(current.bytes, "base64").toString(), file.format, file.changes), current.mode) };
      }));
      for (const file of restores) if (!file.skip) await atomic(file.path, file.restore);
      await unlink(manifestPath);
      return;
    }
    const entries = clientEntries(credentials, brand);
    const files = [];
    const restores = [];
    for (const target of paths) {
      const current = await read(target.path);
      const old = previous?.files.find((file) => file.path === target.path);
      // Nothing to write and nothing of ours to remove: leave the file untouched.
      if (!entries[target.kind].length && !old) continue;
      let source = current ? Buffer.from(current.bytes, "base64").toString() : "";
      let before = current;
      if (old && (current?.bytes === old.after.bytes || current?.bytes === old.input?.bytes)) {
        before = old.before;
        source = before ? Buffer.from(before.bytes, "base64").toString() : "";
      } else if (old) {
        // A rename or rerun preserves edits made since the previous setup.
        source = remove(source, target.format, old.changes);
        before = current ? snapshot(source, current.mode) : null;
      }
      // A file we no longer write goes back to how it was without our entries, absent included.
      if (!entries[target.kind].length) { restores.push({ path: target.path, snapshot: before }); continue; }
      const result = apply(source, target.format, entries[target.kind]);
      if (target.format === "toml") result.source = markToml(result.source, brand);
      files.push({ ...target, before, input: current, after: snapshot(result.source), changes: result.changes });
    }
    await atomic(manifestPath, snapshot(`${JSON.stringify({ id: brand.setup.id, files }, null, 2)}\n`));
    for (const file of files) await atomic(file.path, file.after);
    for (const file of restores) await atomic(file.path, file.snapshot);
  } finally { await rmdir(lock); }
}
