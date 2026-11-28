// A stage's images in the account's container registry. Alchemy pushes a container's image to
// `<account>/<application name>` and no destroy removes it, so the stage finds its repositories by
// name and deletes their manifests itself, in the order the platform's own tool deletes an image:
// the catalog, each repository's tag list, each tag's index and the platform manifests it names
// (read while the tag still names them), then each tag by its tag, then what the tags reached,
// index first, then every digest entry either list named. Every step is a request to the stage's
// choke point (request.mjs), which builds each URL
// from the repository this stage's catalog read recorded and refuses any tag or digest it did not
// find there itself. What the registry keeps of a deleted repository is decided in
// kept-entries.mjs.
import { DIGEST, fail } from "./answers.mjs";
import { closedType, keptByRegistry, refusalClass, registryArtifact } from "./kept-entries.mjs";

/** The registry operations of one stage, over its `send`. */
export function registryOperations(send) {
  /**
   * The stage's repositories, `<account>/<owned name>` one name deep, with every entry each tag list
   * holds: its tags and, on a registry that lists them, its `sha256:` digest entries.
   */
  async function images() {
    const rows = await send({ kind: "images", operation: "list" });
    for (const row of rows)
      row.tags = await send({ kind: "images", operation: "tags", target: row });
    return rows;
  }

  const read = (image, reference) =>
    send({ kind: "images", operation: "manifest", target: image, reference });
  const remove = (image, reference) =>
    send({ kind: "images", operation: "deleteManifest", target: image, reference });
  /** A digest entry's type as its manifest says; undefined when it cannot be read. */
  const typeOf = (image, digest) =>
    read(image, digest).then(
      (manifest) => (manifest ? manifest.type : undefined),
      () => undefined,
    );

  /**
   * Deletes every manifest of one repository `images` found, as the platform's own tool deletes an
   * image: each tag by its tag first, then, from the list read again, each tag still listed by its
   * index and the platforms it names, and every digest entry still listed. Every delete is tried. Returns the entries
   * the registry keeps and `deletes`, closed counts of what each request answered; throws, with a
   * record of the same closed facts, when anything else is left.
   */
  async function removeImage(image) {
    const entries = await send({ kind: "images", operation: "tags", target: image });
    const tags = entries.filter((entry) => !DIGEST.test(entry));
    const digests = entries.filter((entry) => DIGEST.test(entry));
    // Every digest a delete was sent for, so the digest loop never sends one twice.
    const tried = new Set();
    const refused = [];
    // Closed counts only: what the list held, what each tag's read and each delete answered.
    const deletes = {
      tags: tags.length,
      digests: digests.length,
      byTag: { sent: 0, accepted: 0, absent: 0, refused: 0 },
      tagRead: { ok: 0, absent: 0 },
      delete: { accepted: 0, absent: 0, refused: 0 },
    };
    const counted = () =>
      Object.freeze({
        ...deletes,
        byTag: Object.freeze({ ...deletes.byTag }),
        tagRead: Object.freeze({ ...deletes.tagRead }),
        delete: Object.freeze({ ...deletes.delete }),
      });
    try {
      return await removeEntries();
    } catch (error) {
      // Any other stop (a read, the transport, the budget) keeps what was counted up to it.
      if (error !== null && typeof error === "object" && !Object.hasOwn(error, "record"))
        error.record = Object.freeze({
          registryDeletes: Object.freeze({ ...counted(), stopped: true }),
        });
      throw error;
    }
    async function removeEntries() {
      const attempt = async (reference, kind, type) => {
        tried.add(reference);
        try {
          deletes.delete[(await remove(image, reference)) ? "accepted" : "absent"] += 1;
          return undefined;
        } catch (error) {
          const refusal = error !== null && typeof error === "object" ? error.refusal : undefined;
          if (refusal === undefined) throw error;
          deletes.delete.refused += 1;
          return { kind, type, refusal };
        }
      };
      // Each tag's manifests, read while the tag still names them: its index first, then what the
      // index names, so an index is always deleted before the manifests it names.
      const reached = [];
      const reach = async (tag) => {
        const tagged = await read(image, tag);
        deletes.tagRead[tagged ? "ok" : "absent"] += 1;
        if (!tagged) return;
        const order = [tagged.digest];
        for (let next = 0; next < order.length; next++) {
          const named = next === 0 ? tagged : await read(image, order[next]);
          for (const child of named?.children ?? []) if (!order.includes(child)) order.push(child);
        }
        for (const digest of order)
          if (!reached.some((entry) => entry.digest === digest))
            reached.push({ digest, type: tagged.type });
      };
      for (const tag of tags) await reach(tag);
      // Each tag by its tag, as the platform's own tool deletes an image. A registry may keep a
      // tagged manifest whose digest delete it accepts.
      for (const tag of tags) {
        deletes.byTag.sent += 1;
        try {
          deletes.byTag[(await remove(image, tag)) ? "accepted" : "absent"] += 1;
        } catch (error) {
          const refusal = error !== null && typeof error === "object" ? error.refusal : undefined;
          if (refusal === undefined) throw error;
          deletes.byTag.refused += 1;
          refused.push({ kind: "tag", type: undefined, refusal });
        }
      }
      // What the list still names once its tags are gone; a tag the registry kept is read too.
      const left = await send({ kind: "images", operation: "tags", target: image });
      for (const tag of left.filter((entry) => !DIGEST.test(entry))) await reach(tag);
      // What the tags reached, index first: an entry a tag reached is the stage's image.
      for (const { digest, type } of reached) {
        if (tried.has(digest)) continue;
        const failed = await attempt(digest, "tag", type);
        if (failed) refused.push(failed);
      }
      const candidates = [];
      // Every digest entry either list named: a second list that answers empty still leaves the
      // first list's entries to delete.
      for (const digest of new Set([...digests, ...left.filter((entry) => DIGEST.test(entry))])) {
        if (tried.has(digest)) continue;
        const type = await typeOf(image, digest);
        const failed = await attempt(digest, "digest", type);
        if (!failed) continue;
        if (keptByRegistry(type, failed.refusal)) candidates.push({ ...failed, digest });
        else refused.push(failed);
      }
      // Kept only once nothing of the stage's own image was refused, by tag or by digest: an entry
      // beside a refused image is never the registry's.
      const imageRefused = refused.length > 0;
      const kept = imageRefused
        ? []
        : candidates.map(({ type, refusal, digest }) => ({
            type,
            class: refusalClass(refusal),
            digest,
          }));
      if (imageRefused) refused.push(...candidates);
      if (refused.length) {
        const error = fail(
          `Registry repository ${image.name}: ${refused.length} manifest${refused.length === 1 ? "" : "s"} refused deletion (${[...new Set(refused.map((entry) => `HTTP ${refusalClass(entry.refusal)}`))].join(", ")})`,
        );
        error.record = Object.freeze({
          registryDeletes: Object.freeze({
            ...counted(),
            // The digest proves an entry within this process; it never reaches a record.
            kept: Object.freeze(
              kept.map(({ type, class: refused }) => Object.freeze({ type, class: refused })),
            ),
            refused: Object.freeze(
              refused.map((entry) =>
                Object.freeze({
                  entry: entry.kind,
                  digestShaped: entry.kind === "digest",
                  type: closedType(entry.type),
                  class: refusalClass(entry.refusal),
                }),
              ),
            ),
          }),
        });
        throw error;
      }
      return Object.freeze({
        kept: Object.freeze(kept.map((entry) => Object.freeze(entry))),
        deletes: counted(),
      });
    }
  }

  /**
   * One repository as it stands now, read again in this run and never taken from a saved list: its
   * list, then each entry it names read by its own reference. An entry is `absent` only when that
   * read answered 404 while the list, answered to the same credential (request.mjs) just before,
   * named it: the list is the read's positive control. A read that fails any other way, a 5xx or
   * a timeout, is `other` and counts as there. A request the stage did not send stops the read.
   *
   * `gone` holds when every entry is absent and the list names a digest entry; `kept` lists the entries the registry keeps when every
   * entry not absent is a digest entry whose manifest has a kept type, and is undefined otherwise. A
   * read cannot see a delete's refusal, so a deploy that finds a kept repository leaves it to the
   * next teardown to try again.
   */
  async function standing(image) {
    const listed = await send({ kind: "images", operation: "tags", target: image });
    const entries = [];
    for (const entry of listed) {
      let manifest;
      let answered;
      try {
        manifest = await read(image, entry);
        answered = manifest ? "ok" : "absent";
      } catch (error) {
        if (error !== null && typeof error === "object" && Object.hasOwn(error, "sent"))
          throw error;
        answered = "other";
      }
      entries.push(
        Object.freeze({
          entry,
          kind: DIGEST.test(entry) ? "digest" : "tag",
          read: answered,
          type: manifest?.type,
        }),
      );
    }
    const there = entries.filter((row) => row.read !== "absent");
    const kept =
      there.length > 0 &&
      there.every((row) => row.kind === "digest" && row.read === "ok" && registryArtifact(row.type))
        ? Object.freeze(there.map((row) => Object.freeze({ digest: row.entry, type: row.type })))
        : undefined;
    return Object.freeze({
      entries: Object.freeze(entries),
      // A tag alone gives a delete nothing to address, so a list without a digest entry is never
      // gone: the registry as recorded names every manifest by digest beside the tags.
      gone: there.length === 0 && entries.some((row) => row.kind === "digest"),
      kept,
      // Closed counts only: what the list named, and what each read by reference answered.
      facts: Object.freeze({
        tags: entries.filter((row) => row.kind === "tag").length,
        digests: entries.filter((row) => row.kind === "digest").length,
        read: Object.freeze({
          ok: entries.filter((row) => row.read === "ok").length,
          absent: entries.filter((row) => row.read === "absent").length,
          other: entries.filter((row) => row.read === "other").length,
        }),
        control:
          "the repository's tag list, answered to the run's pull credential, named each entry",
      }),
    });
  }

  return { images, removeImage, standing };
}
