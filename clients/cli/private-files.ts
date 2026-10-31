import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

function owned(mode: number, uid: number, directory: boolean) {
  return (
    process.platform === "win32" ||
    ((mode & 0o777) === (directory ? 0o700 : 0o600) && uid === process.getuid?.())
  );
}

export async function privateDirectory(path: string): Promise<string> {
  const target = resolve(path);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const value = await lstat(target);
  if (!value.isDirectory() || value.isSymbolicLink() || !owned(value.mode, value.uid, true))
    throw new Error("The connection directory must belong to you and have permissions 0700.");
  return target;
}

export async function readPrivate(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("Could not open the private connection file.");
  }
  try {
    const value = await handle.stat();
    if (!value.isFile() || value.size > 1_048_576 || !owned(value.mode, value.uid, false))
      throw new Error("Connection files must belong to you and have permissions 0600.");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function writePrivate(path: string, value: string): Promise<void> {
  await privateDirectory(dirname(path));
  const previous = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (
    previous &&
    (!previous.isFile() || previous.isSymbolicLink() || !owned(previous.mode, previous.uid, false))
  )
    throw new Error("Refusing to replace a connection file with unsafe permissions.");
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}
