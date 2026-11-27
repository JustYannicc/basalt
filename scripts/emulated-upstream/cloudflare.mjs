// What the emulated stage has in the account, found and removed through the shared stage API by its
// name prefix: container applications, Workers, the Durable Object namespaces those Workers own,
// and the registry images its deploy pushed.
import { stageCloudflare } from "../stage-cloudflare/api.mjs";
import { publicMessage, StageError } from "./public-error.mjs";

export function emulatedAccount({ accountId, token, prefix, fetcher = fetch }) {
  if (!accountId || !token)
    throw new StageError("The emulated upstream needs the deploy credentials");
  const stage = stageCloudflare({ accountId, token, prefix, fetcher });

  /**
   * Every prefixed resource. A repository whose list is empty holds nothing the registry can still
   * find; one holding only entries the registry keeps (kept-entries.mjs), read again now, is set
   * apart under `kept`, which neither `empty` nor `describe` counts.
   */
  async function inventory() {
    const [workers, repositories] = await Promise.all([stage.inventory(), stage.images()]);
    const images = [];
    const kept = [];
    for (const row of repositories) {
      if (!row.tags.length) continue;
      const types = await stage.keptEntries(row);
      if (types) kept.push({ name: row.name, types, image: row });
      else images.push(row);
    }
    return { ...workers, images, kept };
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
  const empty = (resources) =>
    Object.entries(resources).every(([kind, rows]) => kind === "kept" || rows.length === 0);

  /** Deletes every prefixed resource, then refuses unless a fresh inventory finds none. */
  async function destroy() {
    const before = await inventory();
    const failures = [];
    const records = [];
    const attempt = async (label, operation) => {
      try {
        return await operation();
      } catch (error) {
        failures.push(`${label}: ${publicMessage(error)}`);
        if (error !== null && typeof error === "object" && Object.hasOwn(error, "record"))
          records.push(error.record);
        return undefined;
      }
    };
    for (const app of before.applications)
      await attempt(`container application ${app.name}`, () => stage.remove("applications", app));
    // Deleting a Worker deletes the Durable Object namespaces it owns.
    for (const script of before.scripts)
      await attempt(`Worker ${script.id}`, () => stage.remove("scripts", script));
    // What each repository's delete pass returned in this run: the entries it found kept.
    const keptBy = new Map();
    for (const image of [...before.images, ...before.kept.map((row) => row.image)]) {
      const kept = await attempt(`registry repository ${image.name}`, () =>
        stage.removeImage(image),
      );
      if (kept) keptBy.set(image.name, kept);
    }
    const after = await inventory();
    // A repository is the registry's only when its delete pass in this run returned, and the read
    // after it finds exactly as many kept entries as that pass was refused.
    const unproven = after.kept.filter((row) => keptBy.get(row.name)?.length !== row.types.length);
    if (!empty(after) || records.length || unproven.length) {
      const error = new StageError(
        `Emulated upstream resources remain after teardown: ${[describe(after), ...unproven.map((row) => `registry repository ${row.name} (${row.types.length} entries of a kept type, not proven kept in this run)`)].filter(Boolean).join(", ") || "only entries whose delete was refused"}${failures.length ? `; failed: ${failures.join("; ")}` : ""}`,
      );
      if (records.length) error.record = Object.freeze({ teardown: Object.freeze(records) });
      throw error;
    }
    // Only what is still there is kept: an entry refused, then gone by the read after, is not.
    const kept = after.kept.flatMap((row) => keptBy.get(row.name) ?? []);
    return { before, failures, kept };
  }

  /** The Worker's DELETE_BY lease in epoch milliseconds, or undefined when it has none. */
  async function lease(worker) {
    // The Worker read by its name: absent only when the account has no such Worker.
    const settings = await stage.settings(worker);
    const text = settings?.result?.bindings?.find((row) => row.name === "DELETE_BY")?.text;
    const at = Number(text);
    return Number.isSafeInteger(at) && at > 0 ? at : undefined;
  }

  return { subdomain: stage.subdomain, inventory, destroy, lease, describe, empty };
}
