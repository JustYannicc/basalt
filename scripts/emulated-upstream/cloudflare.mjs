// What the emulated stage has in the account, found and removed through the shared stage API by its
// name prefix: container applications, Workers, the Durable Object namespaces those Workers own,
// and the registry images its deploy pushed.
import { REQUEST_TIMEOUT_MS, stageCloudflare } from "../stage-cloudflare/api.mjs";
import { publicMessage, StageError } from "./public-error.mjs";

/** How long a teardown waits before it reads again what an accepted delete left listed. */
export const readBackPauseMs = 20_000;
/** How many more read-backs a teardown makes after its first, all inside its budget. */
export const readBackRetries = 6;

export function emulatedAccount({
  accountId,
  token,
  prefix,
  fetcher = fetch,
  deadline,
  now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!accountId || !token)
    throw new StageError("The emulated upstream needs the deploy credentials");
  const stage = stageCloudflare({
    accountId,
    token,
    prefix,
    fetcher,
    ...(deadline === undefined ? {} : { deadline, now }),
  });

  /**
   * Every prefixed resource, read in this run and never from a saved record. Each repository is
   * read as it stands now (registry.mjs `standing`): one whose list is empty holds nothing the
   * registry can still find; one whose every entry its own list names and its own read answers 404
   * for, to the same credential, is set apart under `gone`; one holding only entries the registry
   * keeps (kept-entries.mjs) under `kept`. Neither `empty` nor `describe` counts those two.
   * `facts` holds each repository's closed counts, in order, for a record.
   */
  async function inventory() {
    const [workers, repositories] = await Promise.all([stage.inventory(), stage.images()]);
    const images = [];
    const kept = [];
    const gone = [];
    const facts = [];
    for (const row of repositories) {
      if (!row.tags.length) continue;
      const read = await stage.standing(row);
      if (!read.entries.length) continue;
      const placed = read.gone ? "gone" : read.kept ? "kept" : "image";
      facts.push(Object.freeze({ ...read.facts, placed }));
      if (placed === "gone") gone.push({ name: row.name, facts: read.facts, image: row });
      else if (placed === "kept")
        kept.push({
          name: row.name,
          entries: read.kept,
          types: read.kept.map((entry) => entry.type),
          image: row,
        });
      else images.push(row);
    }
    return { ...workers, images, kept, gone, facts };
  }
  /** Names only, never ids or values: these lines go to the public log. */
  const describe = (resources) =>
    [
      ...resources.applications.map((row) => `container application ${row.name}`),
      ...resources.scripts.map((row) => `Worker ${row.id}`),
      ...resources.namespaces.map(
        (row) => `Durable Object namespace ${row.class} of ${row.script}`,
      ),
      ...resources.images.map((row) => {
        const digests = row.tags.filter((entry) => entry.startsWith("sha256:")).length;
        return `registry repository ${row.name} (${row.tags.length - digests} tags, ${digests} digest entries)`;
      }),
    ].join(", ");
  const setApart = new Set(["kept", "gone", "facts"]);
  const empty = (resources) =>
    Object.entries(resources).every(([kind, rows]) => setApart.has(kind) || rows.length === 0);
  /**
   * Whether nothing of the stage runs: no prefixed container application, Worker or Durable Object
   * namespace. Its own image repository may be left; a deploy pushes to that same repository.
   */
  const inert = (resources) =>
    Object.entries(resources).every(
      ([kind, rows]) => setApart.has(kind) || kind === "images" || rows.length === 0,
    );
  /** How many of the stage's own repositories an inventory found, and their listed entries. */
  const repositoryLeft = (resources) => {
    const rows = resources.facts ?? [];
    return Object.freeze({
      repositories: rows.length,
      entries: rows.reduce((sum, row) => sum + row.tags + row.digests, 0),
    });
  };
  /** Closed counts of what an inventory found, by kind. */
  const counted = (resources) =>
    Object.freeze(
      Object.fromEntries(
        Object.entries(resources)
          .filter(([kind]) => kind !== "facts")
          .map(([kind, rows]) => [kind, rows.length]),
      ),
    );

  /**
   * Deletes every prefixed resource, then refuses unless a fresh inventory finds none. Whatever it
   * ends with, it carries a record of closed facts: what it found, what each registry delete
   * answered, and what each read-back saw.
   */
  async function destroy() {
    const before = await inventory();
    const failures = [];
    const records = [];
    // Each repository's delete counts, in order, from its delete pass however that ended.
    const deletes = [];
    const attempt = async (label, operation) => {
      try {
        return await operation();
      } catch (error) {
        failures.push(`${label}: ${publicMessage(error)}`);
        if (error !== null && typeof error === "object" && Object.hasOwn(error, "record")) {
          records.push(error.record);
          if (error.record.registryDeletes) deletes.push(error.record.registryDeletes);
        }
        return undefined;
      }
    };
    for (const app of before.applications)
      await attempt(`container application ${app.name}`, () => stage.remove("applications", app));
    // Deleting a Worker deletes the Durable Object namespaces it owns.
    for (const script of before.scripts)
      await attempt(`Worker ${script.id}`, () => stage.remove("scripts", script));
    // What each repository's delete pass returned in this run: the entries it found kept. A
    // repository whose reads all answered 404 is deleted too: a read can miss a manifest a delete
    // still reaches, and a delete answered 404 counts as absent, so only its pass returning in this
    // run lets the read after set it apart.
    const keptBy = new Map();
    for (const image of [
      ...before.images,
      ...before.kept.map((row) => row.image),
      ...before.gone.map((row) => row.image),
    ]) {
      const removed = await attempt(`registry repository ${image.name}`, () =>
        stage.removeImage(image),
      );
      if (removed) {
        keptBy.set(image.name, removed.kept);
        deletes.push(removed.deletes);
      }
    }
    // An entry is the registry's only when this run's delete pass for its repository returned and
    // was refused that very entry, by digest; the read after is what says it is still there.
    const proven = (row) => new Set((keptBy.get(row.name) ?? []).map((entry) => entry.digest));
    const unprovenOf = (found) =>
      found.kept.filter((row) => {
        const refused = proven(row);
        return !row.entries.every((entry) => refused.has(entry.digest));
      });
    // A repository set apart as gone whose delete pass did not return in this run still counts.
    const unremovedOf = (found) => found.gone.filter((row) => !keptBy.has(row.name));
    const fact = (extra) =>
      Object.freeze({
        found: counted(before),
        foundRepositories: Object.freeze(before.facts),
        failedDeletes: failures.length,
        registryDeletes: Object.freeze(deletes),
        ...extra,
      });
    // The read after the deletes, again while something an accepted delete left is still listed:
    // a registry may collect it a little later. Every read starts only when a request still fits
    // in the run's budget, and a read the budget cuts short ends the teardown with its record.
    const reads = [];
    let after;
    let cut = false;
    try {
      for (;;) {
        after = await inventory();
        reads.push(Object.freeze({ found: counted(after), repositories: after.facts }));
        const settled =
          empty(after) && unprovenOf(after).length === 0 && unremovedOf(after).length === 0;
        if (settled || failures.length || reads.length > readBackRetries) break;
        if (deadline !== undefined && now() + readBackPauseMs + REQUEST_TIMEOUT_MS > deadline) {
          cut = true;
          break;
        }
        await wait(readBackPauseMs);
      }
    } catch (error) {
      // The read that proves the teardown could not finish (its budget, or the registry): the
      // teardown fails with everything it gathered, never as that read's own bare error.
      if (error !== null && typeof error === "object" && Object.hasOwn(error, "record"))
        records.push(error.record);
      const failed = new StageError(
        `Emulated upstream teardown could not read back what remains: ${publicMessage(error)}${failures.length ? `; failed: ${failures.join("; ")}` : ""}`,
      );
      failed.record = fact({
        teardown: Object.freeze(records),
        readBack: "not-completed",
        reads: Object.freeze(reads),
        readBackCut: error !== null && typeof error === "object" && error.budget === true,
      });
      throw failed;
    }
    const unproven = unprovenOf(after);
    for (const row of unproven)
      records.push(
        Object.freeze({
          unproven: Object.freeze({
            entries: row.entries.length,
            proven: row.entries.filter((entry) => proven(row).has(entry.digest)).length,
            types: Object.freeze([...new Set(row.types)]),
          }),
        }),
      );
    const unremoved = unremovedOf(after);
    const record = fact({
      teardown: Object.freeze(records),
      reads: Object.freeze(reads),
      readBackCut: cut,
    });
    if (!empty(after) || records.length || unremoved.length) {
      const error = new StageError(
        `Emulated upstream resources remain after teardown: ${[describe(after), ...unproven.map((row) => `registry repository ${row.name} (${row.types.length} entries of a kept type, not proven kept in this run)`), ...unremoved.map((row) => `registry repository ${row.name} (listed without a manifest, no delete pass in this run)`)].filter(Boolean).join(", ") || "only entries whose delete was refused"}${failures.length ? `; failed: ${failures.join("; ")}` : ""}${cut ? "; the read after was cut by the run's time budget" : ""}`,
      );
      error.record = record;
      throw error;
    }
    // Only what is still there is kept: an entry refused, then gone by the read after, is not.
    const kept = after.kept.flatMap((row) => {
      const there = new Set(row.entries.map((entry) => entry.digest));
      return (keptBy.get(row.name) ?? []).filter((entry) => there.has(entry.digest));
    });
    return { before, failures, kept, gone: after.gone, record };
  }

  /** The Worker's DELETE_BY lease in epoch milliseconds, or undefined when it has none. */
  async function lease(worker) {
    // The Worker read by its name: absent only when the account has no such Worker.
    const settings = await stage.settings(worker);
    const text = settings?.result?.bindings?.find((row) => row.name === "DELETE_BY")?.text;
    const at = Number(text);
    return Number.isSafeInteger(at) && at > 0 ? at : undefined;
  }

  return {
    subdomain: stage.subdomain,
    inventory,
    destroy,
    lease,
    describe,
    empty,
    inert,
    repositoryLeft,
    counted,
  };
}
