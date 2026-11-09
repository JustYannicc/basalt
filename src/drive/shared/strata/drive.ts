import { createListing } from "./listing.js";
import { DriveError, filePath, oid, operation, writerRef } from "./errors.js";
import { createEngine } from "./git/engine.js";
import { objectId } from "./git/objects.js";
import type { Drive, DriveOptions, Edit, Receipt } from "./types.js";

const main = "refs/heads/main";
const fingerprint = async (kind: string, request: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify([kind, request]));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

export function createDrive(options: DriveOptions): Drive {
  const { objects, refs } = options;
  const author = { ...options.author };
  const limits = {
    object: options.maxObjectBytes ?? 8 * 1024 * 1024,
    batch: options.maxBatchBytes ?? 16 * 1024 * 1024,
  };
  if (
    !Number.isSafeInteger(limits.object) ||
    !Number.isSafeInteger(limits.batch) ||
    limits.object < 1 ||
    limits.batch < limits.object
  )
    throw new DriveError("invalid", "Invalid Git byte limits");
  if (
    !author.name ||
    !author.email ||
    !Number.isSafeInteger(author.timestamp) ||
    !Number.isSafeInteger(author.timezoneOffset) ||
    /[\r\n<>]/.test(author.name) ||
    /[\r\n<>]/.test(author.email)
  )
    throw new DriveError("invalid", "Invalid Git author");
  const engine = () => createEngine(objects, author, limits);
  const getMain = async () => {
    const value = await refs.get(main);
    if (!value) throw new DriveError("missing", "Drive has not been initialized");
    return value;
  };
  const checkEdits = async (edits: readonly Edit[]) => {
    if (!edits.length || edits.length > 100)
      throw new DriveError("capacity", "A commit needs between 1 and 100 changed paths");
    const names = new Set<string>();
    let total = 0;
    const hashed: { path: string; object: string | null }[] = [];
    for (const edit of edits) {
      filePath(edit.path);
      const normalized = edit.path.toLocaleLowerCase("en-US");
      if (names.has(normalized))
        throw new DriveError("invalid", "A commit contains duplicate or case-colliding paths");
      names.add(normalized);
      const content =
        typeof edit.content === "string" ? new TextEncoder().encode(edit.content) : edit.content;
      total += content?.length ?? 0;
      if ((content?.length ?? 0) > limits.object || total > limits.batch)
        throw new DriveError("capacity", "Commit exceeds the configured Git byte limit");
      hashed.push({ path: edit.path, object: content ? await objectId("blob", content) : null });
    }
    return hashed;
  };
  return {
    list: createListing(engine, getMain),
    async initialize(id) {
      operation(id);
      const hash = await fingerprint("initialize", { author });
      const prior = await refs.receipt(id, hash);
      if (prior) return prior.oid;
      const existing = await refs.get(main);
      if (existing) return existing;
      const git = await engine(),
        root = await git.initial();
      await git.flush();
      const result = await refs.publish({
        operation: id,
        fingerprint: hash,
        changes: [{ ref: main, expected: null, next: root }],
        receipt: { state: "opened", operation: id, ref: main, oid: root },
      });
      return result.applied ? result.receipt.oid : getMain();
    },
    async openWriter(input) {
      input = { ...input };
      operation(input.operation);
      const ref = writerRef(`refs/heads/writers/${input.id}`);
      const hash = await fingerprint("open", { id: input.id, base: input.base ?? null });
      const prior = await refs.receipt(input.operation, hash);
      if (prior) return { ref: prior.ref, oid: prior.oid };
      const base = oid(input.base ?? (await getMain()));
      await (await engine()).readCommit(base);
      const result = await refs.publish({
        operation: input.operation,
        fingerprint: hash,
        changes: [{ ref, expected: null, next: base }],
        receipt: { state: "opened", operation: input.operation, ref, oid: base },
      });
      if (!result.applied)
        throw new DriveError("stale", "Writer branch already exists; resume its saved head");
      return { ref, oid: result.receipt.oid };
    },
    async commit(input) {
      input = {
        ...input,
        edits: input.edits.map((edit) => ({
          ...edit,
          content: edit.content instanceof Uint8Array ? new Uint8Array(edit.content) : edit.content,
        })),
      };
      operation(input.operation);
      writerRef(input.ref);
      oid(input.expected);
      if (!input.message || input.message.length > 4096)
        throw new DriveError("invalid", "Invalid Git commit message");
      const edits = await checkEdits(input.edits);
      const hash = await fingerprint("commit", {
        ref: input.ref,
        expected: input.expected,
        edits,
        message: input.message,
        author,
      });
      const prior = await refs.receipt(input.operation, hash);
      if (prior) return prior;
      if ((await refs.get(input.ref)) !== input.expected)
        throw new DriveError(
          "stale",
          "Writer head changed; read its current commit before editing",
        );
      const git = await engine(),
        next = await git.commit(input.expected, input.edits, input.message);
      await git.flush();
      const receipt: Receipt = {
        state: "saved",
        operation: input.operation,
        ref: input.ref,
        oid: next,
      };
      const result = await refs.publish({
        operation: input.operation,
        fingerprint: hash,
        changes: [{ ref: input.ref, expected: input.expected, next }],
        receipt,
      });
      if (!result.applied)
        throw new DriveError("stale", "Writer head changed before its commit could be saved");
      return result.receipt;
    },
    async resolve(input) {
      input = {
        ...input,
        edits: input.edits.map((edit) => ({
          ...edit,
          content: edit.content instanceof Uint8Array ? new Uint8Array(edit.content) : edit.content,
        })),
      };
      operation(input.operation);
      writerRef(input.ref);
      oid(input.expected);
      oid(input.main);
      if (!input.message || input.message.length > 4096)
        throw new DriveError("invalid", "Invalid Git commit message");
      const edits = await checkEdits(input.edits);
      const hash = await fingerprint("resolve", { ...input, edits, author });
      const prior = await refs.receipt(input.operation, hash);
      if (prior) return prior;
      if ((await refs.get(input.ref)) !== input.expected || (await getMain()) !== input.main)
        throw new DriveError("stale", "Main or writer head changed; review the current conflict");
      const git = await engine();
      const next = await git.resolve(input.main, input.expected, input.edits, input.message);
      await git.flush();
      const receipt: Receipt = {
        state: "saved",
        operation: input.operation,
        ref: input.ref,
        oid: next,
      };
      const result = await refs.publish({
        operation: input.operation,
        fingerprint: hash,
        changes: [
          { ref: main, expected: input.main, next: input.main },
          { ref: input.ref, expected: input.expected, next },
        ],
        receipt,
      });
      if (!result.applied)
        throw new DriveError("stale", "Main or writer head changed before resolution was saved");
      return result.receipt;
    },
    async land(input) {
      input = { ...input };
      operation(input.operation);
      writerRef(input.ref);
      oid(input.expected);
      const hash = await fingerprint("land", { ref: input.ref, expected: input.expected, author });
      const prior = await refs.receipt(input.operation, hash);
      if (prior) return prior;
      for (let attempt = 0; attempt < 8; attempt++) {
        if ((await refs.get(input.ref)) !== input.expected)
          throw new DriveError("stale", "Writer head changed before landing");
        const current = await getMain(),
          git = await engine();
        const merged = await git.merge(current, input.expected);
        if (!merged.conflicts.length) await git.flush();
        const receipt: Receipt = merged.conflicts.length
          ? {
              state: "conflict",
              operation: input.operation,
              ref: input.ref,
              oid: input.expected,
              main: current,
              conflicts: merged.conflicts,
            }
          : {
              state: "landed",
              operation: input.operation,
              ref: input.ref,
              oid: merged.oid,
              previous: current,
            };
        const result = await refs.publish({
          operation: input.operation,
          fingerprint: hash,
          changes: [
            { ref: main, expected: current, next: merged.conflicts.length ? current : merged.oid },
            { ref: input.ref, expected: input.expected, next: input.expected },
          ],
          receipt,
        });
        if (result.applied) return result.receipt;
      }
      throw new DriveError(
        "contended",
        "Main kept advancing; the writer branch is saved and can land later",
      );
    },
    async read(input) {
      input = { ...input };
      filePath(input.path);
      return (await engine()).read(oid(input.at ?? (await getMain())), input.path);
    },
    async history(input = {}) {
      const limit = input.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new DriveError("invalid", "History limit must be between 1 and 100");
      const git = await engine(),
        pending = [oid(input.at ?? (await getMain()))],
        seen = new Set<string>();
      const commits: { oid: string; parents: readonly string[]; message: string }[] = [];
      while (pending.length && commits.length < limit) {
        const current = pending.shift()!;
        if (seen.has(current)) continue;
        seen.add(current);
        const commit = await git.readCommit(current);
        commits.push({ oid: current, parents: commit.parent, message: commit.message });
        pending.push(...commit.parent);
      }
      return commits;
    },
    receipt: (id) => refs.receipt(operation(id)),
  };
}
