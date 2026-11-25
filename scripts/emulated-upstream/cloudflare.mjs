// What the emulated stage has in the account, found and removed through the shared stage API by its
// name prefix: container applications, Workers, the Durable Object namespaces those Workers own,
// and the registry images its deploy pushed.
import { stageCloudflare } from "../stage-cloudflare/api.mjs";
import { publicMessage, StageError } from "./public-error.mjs";

export function emulatedAccount({ accountId, token, prefix, fetcher = fetch }) {
  if (!accountId || !token)
    throw new StageError("The emulated upstream needs the deploy credentials");
  const stage = stageCloudflare({ accountId, token, prefix, fetcher });

  async function inventory(permissions = ["pull"]) {
    const [workers, repositories] = await Promise.all([
      stage.inventory(),
      stage.images(permissions),
    ]);
    // A repository whose tags are all gone holds nothing the registry can still find.
    return { ...workers, images: repositories.filter((row) => row.tags.length) };
  }
  /** Names only, never ids or values: these lines go to the public log. */
  const describe = (resources) =>
    [
      ...resources.applications.map((row) => `container application ${row.name}`),
      ...resources.scripts.map((row) => `Worker ${row.id}`),
      ...resources.namespaces.map(
        (row) => `Durable Object namespace ${row.class} of ${row.script}`,
      ),
      ...resources.images.map((row) => `registry repository ${row.name} (${row.tags.length} tags)`),
    ].join(", ");
  const empty = (resources) => Object.values(resources).every((rows) => rows.length === 0);

  /** Deletes every prefixed resource, then refuses unless a fresh inventory finds none. */
  async function destroy() {
    const write = ["pull", "push"];
    const before = await inventory(write);
    const failures = [];
    const attempt = async (label, operation) => {
      try {
        await operation();
      } catch (error) {
        failures.push(`${label}: ${publicMessage(error)}`);
      }
    };
    for (const app of before.applications)
      await attempt(`container application ${app.name}`, () => stage.remove("applications", app));
    // Deleting a Worker deletes the Durable Object namespaces it owns.
    for (const script of before.scripts)
      await attempt(`Worker ${script.id}`, () => stage.remove("scripts", script));
    for (const image of before.images)
      await attempt(`registry repository ${image.name}`, () => stage.removeImage(image));
    const after = await inventory(write);
    if (!empty(after))
      throw new StageError(
        `Emulated upstream resources remain after teardown: ${describe(after)}${failures.length ? `; failed: ${failures.join("; ")}` : ""}`,
      );
    return { before, failures };
  }

  /** The Worker's DELETE_BY lease in epoch milliseconds, or undefined when it has none. */
  async function lease(worker) {
    // The Worker read by its name: absent only when the account has no such Worker.
    const settings = await stage.read("scripts", worker, "/settings");
    const text = settings?.result?.bindings?.find((row) => row.name === "DELETE_BY")?.text;
    const at = Number(text);
    return Number.isSafeInteger(at) && at > 0 ? at : undefined;
  }

  return { subdomain: stage.subdomain, inventory, destroy, lease, describe, empty };
}
