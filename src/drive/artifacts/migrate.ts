import { parseCommit, referencedOids } from "../shared/.generated/strata/git/objects.js";
import type { GitObject, ObjectStore } from "../shared/strata/types.ts";
import type { Bucket } from "../shared/index.ts";
import type { VaultRepository } from "./stores.ts";

/** Below Artifacts' 67,108,864-byte request and 50,000-object push limits, with pkt-line room. */
const defaults = { bytes: 60 * 1024 * 1024, objects: 45_000 };
const main = "refs/heads/main";

/**
 * Copy an R2-pack vault's whole history into its Artifacts repository. Objects keep their bytes,
 * so every commit keeps its id. Pushes go parents first; each advances main only to a commit
 * whose closure is already on the remote, so an interrupted migration resumes from what landed.
 */
export async function migrateVault(input: {
  objects: ObjectStore;
  /** Every ref the source drive holds: main plus any writer branches. */
  refs: Readonly<Record<string, string>>;
  repository: VaultRepository;
  limits?: Partial<typeof defaults>;
}) {
  const limits = { ...defaults, ...input.limits };
  const source = input.refs[main];
  if (!source) throw new Error("The source vault has no main branch");
  const load = async (oid: string) => {
    const object = await input.objects.get(oid);
    if (!object) throw new Error(`The source vault is missing Git object ${oid}`);
    return object;
  };
  const remote = await input.repository.refs();
  const sent = new Set<string>();
  // A resumed migration starts from the remote main, whose closure is complete by construction.
  if (remote[main]) for (const oid of await commitsFrom(remote[main], load)) sent.add(oid);

  let pushes = 0;
  const closure = async (root: string, into: GitObject[]) => {
    const queue = [root];
    while (queue.length) {
      const oid = queue.pop()!;
      if (sent.has(oid)) continue;
      sent.add(oid);
      const object = await load(oid);
      into.push(object);
      if (object.type === "tree") queue.push(...referencedOids("tree", object.content));
    }
  };
  /**
   * Push one branch's history in bounded chunks, parents first. Each chunk advances the ref only to
   * a commit whose closure has landed, so every push stays within the repository's limits.
   */
  const pushChain = async (ref: string, tip: string, start: string | null) => {
    let landed = start,
      batch: GitObject[] = [],
      bytes = 0,
      head: string | null = null;
    const flush = async () => {
      if (!head) return;
      const result = await input.repository.push({
        updates: [{ ref, old: landed, next: head }],
        objects: batch,
      });
      if (!result.applied || result.results[ref] !== "ok")
        throw new Error("The repository refused a migration push; the branch changed meanwhile");
      landed = head;
      pushes++;
      batch = [];
      bytes = 0;
      head = null;
    };
    for (const commit of await commitsFrom(tip, load)) {
      if (sent.has(commit)) continue;
      const objects: GitObject[] = [];
      await closure(parseCommit((await load(commit)).content).tree, objects);
      sent.add(commit);
      objects.push(await load(commit));
      const size = objects.reduce((total, object) => total + object.content.length, 0);
      if (
        batch.length &&
        (bytes + size > limits.bytes || batch.length + objects.length > limits.objects)
      )
        await flush();
      batch.push(...objects);
      bytes += size;
      head = commit;
    }
    await flush();
    // A branch whose commits all landed with main still needs its ref.
    if (landed !== tip) {
      const result = await input.repository.push({
        updates: [{ ref, old: landed, next: tip }],
        objects: [],
      });
      if (!result.applied || result.results[ref] !== "ok")
        throw new Error("The repository refused a migration push; the branch changed meanwhile");
      pushes++;
    }
  };

  await pushChain(main, source, remote[main] ?? null);

  // Unlanded writer branches become kept conflict branches, so no saved work is left behind.
  const branches: Record<string, string> = {};
  for (const [ref, oid] of Object.entries(input.refs)) {
    if (!ref.startsWith("refs/heads/writers/") || sent.has(oid)) continue;
    const target = `refs/heads/conflicts/${ref.slice("refs/heads/writers/".length)}`;
    const current = (await input.repository.refs())[target] ?? null;
    branches[target] = oid;
    if (current !== oid) await pushChain(target, oid, current);
  }
  return { main: source, pushes, objects: sent.size, branches };
}

/** Commits reachable from a head, every parent before its children. */
async function commitsFrom(head: string, load: (oid: string) => Promise<GitObject>) {
  const order: string[] = [],
    done = new Set<string>(),
    stack: { oid: string; expanded: boolean }[] = [{ oid: head, expanded: false }];
  while (stack.length) {
    const top = stack.pop()!;
    if (done.has(top.oid)) continue;
    if (top.expanded) {
      done.add(top.oid);
      order.push(top.oid);
      continue;
    }
    stack.push({ oid: top.oid, expanded: true });
    for (const parent of parseCommit((await load(top.oid)).content).parents)
      if (!done.has(parent)) stack.push({ oid: parent, expanded: false });
  }
  return order;
}

/** Copy a vault's attachment records key for key. They are content-addressed, so ids don't change. */
export async function copyAttachments(input: {
  from: Bucket;
  to: Bucket;
  fromPrefix: string;
  toPrefix: string;
}) {
  let cursor: string | undefined,
    copied = 0;
  do {
    const page = await input.from.list({
      prefix: `${input.fromPrefix}attachments/`,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const { key } of page.objects) {
      const object = await input.from.get(key);
      if (!object) throw new Error("An attachment record vanished during migration");
      await input.to.put(
        input.toPrefix + key.slice(input.fromPrefix.length),
        new Uint8Array(await object.arrayBuffer()),
      );
      copied++;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { copied };
}
