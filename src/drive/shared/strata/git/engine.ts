import { decodeAttachmentPointer } from "../bytes.js";
import git from "isomorphic-git";
import { readDirectory } from "./list.js";
import { DriveError, filePath, oid as validateOid } from "../errors.js";
import type { Author, Bytes, Conflict, Edit, GitObject, ObjectStore, Oid } from "../types.js";
import { createFilesystem } from "./filesystem.js";
import { concatBytes, deflate, inflate, objectId } from "./objects.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function parseLoose(bytes: Bytes): GitObject {
  const end = bytes.indexOf(0);
  if (end < 0 || end > 100) throw new DriveError("integrity", "Invalid loose Git object header");
  const [type, size] = decoder.decode(bytes.subarray(0, end)).split(" ");
  if (type !== "blob" && type !== "tree" && type !== "commit" && type !== "tag")
    throw new DriveError("integrity", "Invalid Git object type");
  const content = bytes.slice(end + 1);
  if (String(content.length) !== size)
    throw new DriveError("integrity", "Invalid Git object length");
  return { oid: "", type, content };
}

export async function createEngine(
  objects: ObjectStore,
  author: Author,
  limits: { object: number; batch: number },
) {
  const fs = createFilesystem(
    async (oid) => {
      const object = await objects.get(validateOid(oid));
      if (!object) return null;
      if (object.content.length > limits.object)
        throw new DriveError("capacity", "Git object exceeds the configured byte limit");
      if (object.oid !== oid || (await objectId(object.type, object.content)) !== oid)
        throw new DriveError("integrity", "Stored Git object hash mismatch");
      return deflate(
        concatBytes([encoder.encode(`${object.type} ${object.content.length}\0`), object.content]),
      );
    },
    Math.max(limits.batch * 4, limits.object * 4),
  );
  const context = { fs, dir: "/repo" };
  await git.init({ ...context, defaultBranch: "main" });
  const readCommit = async (oid: Oid) =>
    (await git.readCommit({ ...context, oid: validateOid(oid) })).commit;
  const blobAt = async (commit: Oid, path: string) => {
    filePath(path);
    try {
      return await git.readBlob({ ...context, oid: commit, filepath: path });
    } catch (error) {
      if (error instanceof git.Errors.NotFoundError) return null;
      throw error;
    }
  };
  const treeEdit = async (
    tree: Oid,
    parts: readonly string[],
    content: string | Bytes | null,
  ): Promise<Oid> => {
    const [name, ...rest] = parts;
    if (!name) throw new DriveError("invalid", "An edit needs a file path");
    const entries = (await git.readTree({ ...context, oid: tree })).tree;
    if (
      entries.some(
        (entry) =>
          entry.path !== name &&
          entry.path.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"),
      )
    )
      throw new DriveError("invalid", "Path collides on a case-insensitive device");
    const existing = entries.find((entry) => entry.path === name);
    let next = entries.filter((entry) => entry.path !== name);
    if (rest.length) {
      if (existing && existing.type !== "tree")
        throw new DriveError("invalid", "A parent path is not a directory");
      const child = existing?.oid ?? (await git.writeTree({ ...context, tree: [] }));
      const changed = await treeEdit(child, rest, content);
      const children = (await git.readTree({ ...context, oid: changed })).tree;
      if (children.length)
        next = [...next, { path: name, mode: "040000", type: "tree", oid: changed }];
    } else if (content !== null) {
      if (existing?.type === "tree")
        throw new DriveError("invalid", "A file cannot replace a directory");
      const bytes = typeof content === "string" ? encoder.encode(content) : content;
      if (bytes.length > limits.object)
        throw new DriveError("capacity", "Edited file exceeds the configured object limit");
      next = [
        ...next,
        {
          path: name,
          mode: "100644",
          type: "blob",
          oid: await git.writeBlob({ ...context, blob: bytes }),
        },
      ];
    }
    return git.writeTree({ ...context, tree: next });
  };
  const filesAt = async (commit: Oid) => {
    const files = new Map<string, Oid>();
    const walk = async (tree: Oid, prefix: string) => {
      for (const entry of (await git.readTree({ ...context, oid: tree })).tree) {
        const path = prefix + entry.path;
        filePath(path);
        if (entry.type === "tree") await walk(entry.oid, `${path}/`);
        else files.set(path, entry.oid);
        if (files.size > 100_000)
          throw new DriveError("capacity", "Git tree exceeds the supported entry count");
      }
    };
    await walk((await readCommit(commit)).tree, "");
    return files;
  };
  const conflictDetails = async (
    paths: readonly string[],
    base: Oid | null,
    ours: Oid,
    theirs: Oid,
    reason: Conflict["reason"],
  ): Promise<Conflict[]> =>
    Promise.all(
      paths.map(async (path) => ({
        path,
        reason,
        base,
        ours,
        theirs,
        baseBlob: base && path !== "." ? ((await blobAt(base, path))?.oid ?? null) : null,
        oursBlob: path === "." ? null : ((await blobAt(ours, path))?.oid ?? null),
        theirsBlob: path === "." ? null : ((await blobAt(theirs, path))?.oid ?? null),
      })),
    );
  const commit = async (base: Oid, edits: readonly Edit[], message: string) => {
    let tree = (await readCommit(base)).tree;
    for (const edit of edits) tree = await treeEdit(tree, filePath(edit.path), edit.content);
    return git.writeCommit({
      ...context,
      commit: { tree, parent: [base], author, committer: author, message },
    });
  };
  const merge = async (
    ours: Oid,
    theirs: Oid,
  ): Promise<{ oid: Oid; conflicts: readonly Conflict[] }> => {
    if (ours === theirs || (await git.isDescendent({ ...context, oid: ours, ancestor: theirs })))
      return { oid: ours, conflicts: [] };
    if (await git.isDescendent({ ...context, oid: theirs, ancestor: ours }))
      return { oid: theirs, conflicts: [] };
    const bases = await git.findMergeBase({ ...context, oids: [ours, theirs] });
    const base = bases.length === 1 ? bases[0]! : null;
    const oursFiles = await filesAt(ours),
      theirsFiles = await filesAt(theirs);
    const baseFiles = base ? await filesAt(base) : new Map<string, Oid>();
    const shared = [
      ...new Set([...oursFiles.keys(), ...theirsFiles.keys(), ...baseFiles.keys()]),
    ].filter(
      (path) =>
        oursFiles.get(path) !== theirsFiles.get(path) &&
        oursFiles.get(path) !== baseFiles.get(path) &&
        theirsFiles.get(path) !== baseFiles.get(path),
    );
    if (!base)
      return {
        oid: theirs,
        conflicts: await conflictDetails(
          shared.length ? shared : ["."],
          null,
          ours,
          theirs,
          "unsupported",
        ),
      };
    const binary: string[] = [];
    for (const path of shared) {
      for (const commit of [base, ours, theirs]) {
        const blob = await blobAt(commit, path);
        if (blob) {
          try {
            new TextDecoder("utf-8", { fatal: true }).decode(blob.blob);
            if (blob.blob.includes(0) || decodeAttachmentPointer(blob.blob)) binary.push(path);
          } catch {
            binary.push(path);
          }
        }
      }
    }
    if (binary.length)
      return {
        oid: theirs,
        conflicts: await conflictDetails([...new Set(binary)], base, ours, theirs, "unsupported"),
      };
    try {
      const result = await git.merge({
        ...context,
        ours,
        theirs,
        noUpdateBranch: true,
        abortOnConflict: true,
        author,
        committer: author,
        message: "Merge writer branch\n",
      });
      if (!result.oid) throw new DriveError("integrity", "Git merge returned no commit");
      const names = new Map<string, string>();
      for (const path of (await filesAt(result.oid)).keys()) {
        const parts = filePath(path);
        for (let i = 1; i <= parts.length; i++) {
          const prefix = parts.slice(0, i).join("/");
          const key = prefix.toLocaleLowerCase("en-US");
          if (names.has(key) && names.get(key) !== prefix)
            return {
              oid: theirs,
              conflicts: await conflictDetails(["."], base, ours, theirs, "unsupported"),
            };
          names.set(key, prefix);
        }
      }
      return { oid: result.oid, conflicts: [] };
    } catch (error) {
      if (error instanceof git.Errors.MergeConflictError)
        return {
          oid: theirs,
          conflicts: await conflictDetails(error.data.filepaths, base, ours, theirs, "content"),
        };
      if (error instanceof git.Errors.MergeNotSupportedError)
        return {
          oid: theirs,
          conflicts: await conflictDetails(
            shared.length ? shared : ["."],
            base,
            ours,
            theirs,
            "unsupported",
          ),
        };
      throw error;
    }
  };
  return {
    list: (commit: Oid, path: string, after: string, limit: number) =>
      readDirectory(context, commit, path, after, limit),
    commit,
    merge,
    async resolve(ours: Oid, theirs: Oid, edits: readonly Edit[], message: string) {
      const result = await merge(ours, theirs);
      if (!result.conflicts.length)
        throw new DriveError("invalid", "No conflict to resolve; land the branch");
      const paths = new Set(edits.map((edit) => edit.path));
      if (result.conflicts.some((conflict) => conflict.path === "." || !paths.has(conflict.path)))
        throw new DriveError(
          "invalid",
          "Resolve every conflicting path; unsupported tree conflicts need a separate strategy",
        );
      // Equal explicit choices on both temporary trees let Git retain clean changes elsewhere.
      const left = await commit(ours, edits, "Prepare explicit resolution\n");
      const right = await commit(theirs, edits, "Prepare explicit resolution\n");
      const resolved = await merge(left, right);
      if (resolved.conflicts.length)
        throw new DriveError("invalid", "Resolution still has unsupported conflicts");
      const tree = (await readCommit(resolved.oid)).tree;
      return git.writeCommit({
        ...context,
        commit: { tree, parent: [ours, theirs], author, committer: author, message },
      });
    },
    async initial() {
      const tree = await git.writeTree({ ...context, tree: [] });
      return git.writeCommit({
        ...context,
        commit: { tree, parent: [], author, committer: author, message: "Initialize drive\n" },
      });
    },
    async read(commit: Oid, path: string) {
      const result = await blobAt(commit, path);
      return result
        ? { oid: commit, blob: result.oid, content: new Uint8Array(result.blob) }
        : null;
    },
    readCommit,
    async flush() {
      const pending: GitObject[] = [];
      let bytes = 0;
      for (const file of fs.dirtyObjects()) {
        const object = parseLoose(await inflate(file.data, limits.object + 128));
        if (object.content.length > limits.object)
          throw new DriveError("capacity", "New Git object exceeds the configured byte limit");
        object.oid = await objectId(object.type, object.content);
        if (object.oid !== file.oid)
          throw new DriveError("integrity", "New Git object hash mismatch");
        bytes += object.content.length;
        if (bytes > limits.batch)
          throw new DriveError("capacity", "Git commit exceeds the configured batch byte limit");
        pending.push(object);
      }
      await objects.put(pending);
    },
  };
}
