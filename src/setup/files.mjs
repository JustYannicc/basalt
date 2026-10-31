import { mkdir, readFile, lstat, writeFile, rename, unlink, rmdir, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { apply, clientEntries, markToml, remove } from "./config.mjs";

async function read(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Config paths must be regular files.");
    return { bytes: (await readFile(path)).toString("base64"), mode: stat.mode & 0o777 };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function atomic(path, snapshot) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (snapshot === null) {
    await unlink(path).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, Buffer.from(snapshot.bytes, "base64"), {
      mode: snapshot.mode,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
const snapshot = (source, mode = 0o600) => ({
  bytes: Buffer.from(source).toString("base64"),
  mode,
});

export function configPaths(home, env) {
  const claude = resolve(env.CLAUDE_CONFIG_DIR || join(home, ".claude"));
  const codex = resolve(env.CODEX_HOME || join(home, ".codex"));
  return [
    { kind: "claude", path: join(claude, "settings.json"), format: "json" },
    {
      kind: "claudeMcp",
      path: env.CLAUDE_CONFIG_DIR ? join(claude, ".claude.json") : join(home, ".claude.json"),
      format: "json",
    },
    { kind: "codex", path: join(codex, "config.toml"), format: "toml" },
  ];
}

async function plan({ home, env = {}, brand, credentials, clients, undo = false }) {
  const directory = join(home, ".local", "state", brand.setup.id);
  const manifestPath = join(directory, "backups.json");
  const manifestBytes = await read(manifestPath);
  const previous = manifestBytes
    ? JSON.parse(Buffer.from(manifestBytes.bytes, "base64").toString())
    : null;
  if (previous && previous.id !== brand.setup.id)
    throw new Error("The backup belongs to another setup.");
  const paths = configPaths(home, env);
  if (
    previous &&
    !previous.files.every((file) => paths.some((target) => target.path === file.path))
  )
    throw new Error("Config directories changed. Run undo using the original directories first.");
  const observations = [];
  const observe = async (path) => {
    const current = await read(path);
    observations.push({ path, current });
    return current;
  };
  const configured = {
    claude:
      previous?.files.some((file) => file.kind === "claude" || file.kind === "claudeMcp") ?? false,
    codex: previous?.files.some((file) => file.kind === "codex") ?? false,
  };
  const files = [],
    writes = [],
    restores = [],
    review = [];
  if (undo && previous) {
    // Parse everything before touching any file.
    for (const file of previous.files) {
      const current = await observe(file.path);
      let restore;
      if (current?.bytes === file.before?.bytes) continue;
      if (current?.bytes === file.after.bytes || current?.bytes === file.input?.bytes)
        restore = file.before;
      else if (!current) continue;
      else
        restore = snapshot(
          remove(Buffer.from(current.bytes, "base64").toString(), file.format, file.changes),
          current.mode,
        );
      restores.push({ path: file.path, snapshot: restore });
      review.push({
        kind: file.kind,
        path: file.path,
        action: "restore",
        fields: file.changes.map((change) => change.path.join(".")),
      });
    }
  }
  const selection = clients ?? { claude: credentials, codex: credentials };
  if (Object.keys(selection).some((name) => !["claude", "codex"].includes(name)))
    throw new Error("Choose Claude Code or Codex.");
  const claude = selection.claude === "keep" ? null : clientEntries(selection.claude, brand);
  const codex = selection.codex === "keep" ? null : clientEntries(selection.codex, brand);
  const entries = {
    claude: claude?.claude ?? [],
    claudeMcp: claude?.claudeMcp ?? [],
    codex: codex?.codex ?? [],
  };
  for (const target of undo ? [] : paths) {
    const old = previous?.files.find((file) => file.path === target.path);
    const keep = selection[target.kind === "codex" ? "codex" : "claude"] === "keep";
    // Nothing to write and nothing of ours to remove: leave the file untouched.
    if (!entries[target.kind].length && !old) continue;
    const current = await observe(target.path);
    if (keep) {
      if (old) files.push(old);
      review.push({ kind: target.kind, path: target.path, action: "keep", fields: [] });
      continue;
    }
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
    if (!entries[target.kind].length) {
      restores.push({ path: target.path, snapshot: before });
      review.push({
        kind: target.kind,
        path: target.path,
        action: "restore",
        fields: old.changes.map((change) => change.path.join(".")),
      });
      continue;
    }
    const result = apply(source, target.format, entries[target.kind]);
    if (target.format === "toml") result.source = markToml(result.source, brand);
    const file = {
      ...target,
      before,
      input: current,
      after: snapshot(result.source),
      changes: result.changes,
    };
    files.push(file);
    writes.push(file);
    review.push({
      kind: target.kind,
      path: target.path,
      action: "update",
      fields: result.changes.map((change) => change.path.join(".")),
    });
  }
  const revision = createHash("sha256")
    .update(JSON.stringify({ paths, manifestBytes, observations }))
    .digest("hex");
  return { manifestPath, previous, files, writes, restores, review, configured, revision };
}

/** Preview exposes paths and setting names, never config values or credentials. */
export async function previewConfiguration(options) {
  const lock = join(options.home, ".local", "state", options.brand.setup.id, "lock");
  if (
    await lstat(lock).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )
  )
    throw new Error(
      "Setup is already running. If interrupted, remove its setup lock and run undo.",
    );
  const result = await plan(options);
  return { files: result.review, configured: result.configured, revision: result.revision };
}

/** Backups are committed before any config write. An interrupted write is recoverable by undo. */
export async function configure(options) {
  const { home, brand, undo = false, expectedRevision } = options;
  const directory = join(home, ".local", "state", brand.setup.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lock = join(directory, "lock");
  try {
    await mkdir(lock);
  } catch {
    throw new Error(
      "Setup is already running. If it was interrupted, remove its setup lock and run undo.",
    );
  }
  try {
    const { manifestPath, previous, files, writes, restores, revision } = await plan(options);
    if (expectedRevision !== undefined && expectedRevision !== revision)
      throw new Error("Config changed after preview. Review the changes again.");
    // Restores run while the previous manifest still tracks those files, so an interruption stays undoable.
    for (const file of restores) await atomic(file.path, file.snapshot);
    if (undo) {
      if (previous) await unlink(manifestPath);
      return;
    }
    await atomic(
      manifestPath,
      snapshot(`${JSON.stringify({ id: brand.setup.id, files }, null, 2)}\n`),
    );
    for (const file of writes) await atomic(file.path, file.after);
  } finally {
    await rmdir(lock);
  }
}
