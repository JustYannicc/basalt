// A stage's images in the account's container registry. Alchemy pushes a container's image to
// `<account>/<application name>` and no destroy removes it, so the stage finds its repositories by
// name and deletes their manifests itself, as the rehearsal teardown does
// (scripts/release/stage-teardown.ts): the catalog, each repository's tag list, then every tagged
// manifest with the platform manifests an index names, then every digest entry the list still
// names. Every step is a request to the stage's choke point (request.mjs), which builds each URL
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
   * Deletes every manifest of one repository `images` found: each tag's index and the platforms it
   * names, then every digest entry the list still names. Every delete is tried. Returns the entries
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
      tagRead: { ok: 0, absent: 0 },
      delete: { accepted: 0, absent: 0, refused: 0 },
    };
    const counted = () =>
      Object.freeze({
        ...deletes,
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
      for (const tag of tags) {
        const tagged = await read(image, tag);
        deletes.tagRead[tagged ? "ok" : "absent"] += 1;
        if (!tagged) continue;
        const reached = [tagged.digest];
        for (let next = 0; next < reached.length; next++) {
          const named = next === 0 ? tagged : await read(image, reached[next]);
          for (const child of named?.children ?? [])
            if (!reached.includes(child)) reached.push(child);
        }
        for (const digest of reached) {
          if (tried.has(digest)) continue;
          const failed = await attempt(digest, "tag", tagged.type);
          if (failed) refused.push(failed);
        }
      }
      const kept = [];
      for (const digest of digests) {
        if (tried.has(digest)) continue;
        const type = await typeOf(image, digest);
        const failed = await attempt(digest, "digest", type);
        if (!failed) continue;
        // Kept only once no tag's manifest was refused: an entry a tag reached is the stage's image.
        if (!refused.some((entry) => entry.kind === "tag") && keptByRegistry(type, failed.refusal))
          kept.push({ type, class: refusalClass(failed.refusal), digest });
        else refused.push(failed);
      }
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
   * `gone` holds when every entry is absent; `kept` lists the entries the registry keeps when every
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
      gone: entries.length > 0 && there.length === 0,
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
