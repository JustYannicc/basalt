// The Cloudflare account API for isolated test stages. A stage tool names its prefix and gets back
// operations on what that prefix owns, each one request to the stage's choke point (request.mjs):
// it never gets a path, a URL or the network. The choke point refuses anything outside the stage
// before it sends, so no stage can read, change or delete a resource the release stack or another
// stage owns.
import { stageOwnership } from "./ownership.mjs";
import { registryOperations } from "./registry.mjs";
import { fail, isCloudflareApiError, stageRequests } from "./request.mjs";

export { isCloudflareApiError };
export const WORKER_KINDS = ["applications", "namespaces", "scripts"];

/**
 * One stage's view of one account. `prefix` is the stage's (see ownership.mjs); `owns`, when
 * given, narrows it further. Construction throws on a prefix or predicate that could own a
 * release name. `signal` gives each call its deadline.
 */
export function stageCloudflare({
  accountId,
  token,
  prefix,
  owns,
  fetcher = fetch,
  signal = () => AbortSignal.timeout(30_000),
}) {
  let owned;
  try {
    owned = stageOwnership(prefix, owns);
  } catch (error) {
    // ownership.mjs raises only fixed refusals; anything else is not printed.
    const message = String(error?.message);
    throw fail(message.startsWith("Refused stage ") ? message : "Refused stage ownership");
  }
  const send = stageRequests({ accountId, token, owned, fetcher, signal });
  const registry = registryOperations(send);

  /** The stage's rows of each kind, listed account-wide at once. */
  async function inventory(kinds = WORKER_KINDS) {
    if (!Array.isArray(kinds)) throw fail("Refused: an inventory names a list of kinds");
    const listed = await Promise.all(kinds.map((kind) => send({ kind, operation: "list" })));
    return Object.fromEntries(kinds.map((kind, index) => [kind, listed[index]]));
  }

  return {
    prefix,
    owned,
    inventory,
    /** One listed resource; null when it no longer exists. */
    read: (kind, row) => send({ kind, operation: "read", target: row }),
    /** A stage Worker's settings, by its name or its listed row; null when it does not exist. */
    settings: (worker) => send({ kind: "scripts", operation: "settings", target: worker }),
    /** A partial update of one listed resource. */
    patch: (kind, row, body) => send({ kind, operation: "patch", target: row, body }),
    /** A rollout of one listed container application. */
    rollout: (kind, row, body) => send({ kind, operation: "rollout", target: row, body }),
    /** Deletes one listed resource. */
    remove: (kind, row) => send({ kind, operation: "delete", target: row }),
    images: registry.images,
    removeImage: registry.removeImage,
    /** The account's workers.dev subdomain, from which a stage Worker's origin follows. */
    subdomain: () => send({ kind: "account", operation: "subdomain" }),
    /**
     * The image every container application in the account runs, and nothing else of it: the
     * scale test finds its frozen pool image here. No row is returned, so none can be changed.
     */
    imageReferences: () => send({ kind: "account", operation: "imageReferences" }),
  };
}
