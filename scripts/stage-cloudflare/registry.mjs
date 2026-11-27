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
   * the registry keeps; throws, with a record of closed facts, when anything else is left.
   */
  async function removeImage(image) {
    const entries = await send({ kind: "images", operation: "tags", target: image });
    const tags = entries.filter((entry) => !DIGEST.test(entry));
    const digests = entries.filter((entry) => DIGEST.test(entry));
    // Every digest a delete was sent for, so the digest loop never sends one twice.
    const tried = new Set();
    const refused = [];
    const attempt = async (reference, kind, type) => {
      tried.add(reference);
      try {
        await remove(image, reference);
        return undefined;
      } catch (error) {
        const refusal = error !== null && typeof error === "object" ? error.refusal : undefined;
        if (refusal === undefined) throw error;
        return { kind, type, refusal };
      }
    };
    for (const tag of tags) {
      const tagged = await read(image, tag);
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
        kept.push({ type, class: refusalClass(failed.refusal) });
      else refused.push(failed);
    }
    if (refused.length) {
      const error = fail(
        `Registry repository ${image.name}: ${refused.length} manifest${refused.length === 1 ? "" : "s"} refused deletion (${[...new Set(refused.map((entry) => `HTTP ${refusalClass(entry.refusal)}`))].join(", ")})`,
      );
      error.record = Object.freeze({
        registryDeletes: Object.freeze({
          kept: Object.freeze(kept.map((entry) => Object.freeze({ ...entry }))),
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
    return Object.freeze(kept.map((entry) => Object.freeze(entry)));
  }

  /**
   * The entries of one repository the registry keeps, read again now and never taken from a saved
   * list: every entry a digest entry whose manifest has a kept type. Undefined when the repository
   * holds a tag or any other entry. A read cannot see a delete's refusal, so a deploy that finds
   * such a repository leaves it to the next teardown to try again.
   */
  async function keptEntries(image) {
    const entries = await send({ kind: "images", operation: "tags", target: image });
    if (!entries.length || !entries.every((entry) => DIGEST.test(entry))) return undefined;
    const types = [];
    for (const digest of entries) {
      const type = await typeOf(image, digest);
      if (!registryArtifact(type)) return undefined;
      types.push(type);
    }
    return Object.freeze(types);
  }

  return { images, removeImage, keptEntries };
}
