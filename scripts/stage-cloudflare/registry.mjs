// A stage's images in the account's container registry. Alchemy pushes a container's image to
// `<account>/<application name>` and no destroy removes it, so the stage finds its repositories by
// name and deletes their tagged manifests itself, as the rehearsal teardown does
// (scripts/release/stage-teardown.ts): the catalog, each repository's tags, then every tagged
// manifest with the platform manifests an index names. Every step is a request to the stage's
// choke point (request.mjs), which builds each URL from the repository this stage's catalog read
// recorded and refuses any tag or digest it did not find there itself.

/** The registry operations of one stage, over its `send`. */
export function registryOperations(send) {
  /** The stage's repositories, `<account>/<owned name>` one name deep, with the tags each holds. */
  async function images() {
    const rows = await send({ kind: "images", operation: "list" });
    for (const row of rows)
      row.tags = await send({ kind: "images", operation: "tags", target: row });
    return rows;
  }

  /** Deletes every tagged manifest of one repository `images` found, the index before its platforms. */
  async function removeImage(image) {
    const tags = await send({ kind: "images", operation: "tags", target: image });
    const manifest = (reference) =>
      send({ kind: "images", operation: "manifest", target: image, reference });
    for (const tag of tags) {
      const tagged = await manifest(tag);
      if (!tagged) continue;
      const digests = [tagged.digest];
      for (let next = 0; next < digests.length; next++) {
        const named = next === 0 ? tagged : await manifest(digests[next]);
        for (const child of named?.children ?? [])
          if (!digests.includes(child)) digests.push(child);
      }
      for (const digest of digests)
        await send({
          kind: "images",
          operation: "deleteManifest",
          target: image,
          reference: digest,
        });
    }
  }

  return { images, removeImage };
}
