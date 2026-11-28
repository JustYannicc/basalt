// The Cloudflare account API for isolated test stages. A stage tool names its prefix and gets back
// operations on what that prefix owns, each one request to the stage's choke point (request.mjs):
// it never gets a path, a URL, a credential or the network. The choke point derives the stage's
// ownership from its prefix and refuses anything outside the stage before it sends, so no stage can
// read, change or delete a resource the release stack or another stage owns.
import { registryOperations } from "./registry.mjs";
import { fail, isCloudflareApiError } from "./answers.mjs";
import { REQUEST_TIMEOUT_MS, stageRequests } from "./request.mjs";

export { isCloudflareApiError, REQUEST_TIMEOUT_MS };
export const WORKER_KINDS = Object.freeze(["applications", "namespaces", "scripts"]);

/** An operation that takes no argument, refusing any it is handed. */
const noArguments =
  (name, operation) =>
  (...given) =>
    given.length ? Promise.reject(fail(`Refused: ${name} takes no arguments`)) : operation();

/**
 * One stage's view of one account, built from the options stageRequests takes (request.mjs).
 * `prefix` is the stage's registered prefix (see ownership.mjs); `owns`, when given, narrows it
 * further. Construction throws on a prefix or predicate that could own a release name. `signal`
 * gives each call its deadline.
 */
export function stageCloudflare(options) {
  const { send, owned, prefix } = stageRequests(options);
  const registry = registryOperations(send);

  /** The stage's rows of each kind, listed account-wide at once. */
  async function inventory(kinds = WORKER_KINDS) {
    if (!Array.isArray(kinds)) throw fail("Refused: an inventory names a list of kinds");
    const named = [...kinds];
    const listed = await Promise.all(named.map((kind) => send({ kind, operation: "list" })));
    return Object.fromEntries(named.map((kind, index) => [kind, listed[index]]));
  }

  return Object.freeze({
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
    images: noArguments("images", registry.images),
    removeImage: registry.removeImage,
    /** One repository as it stands now, each entry read again by its own reference. */
    standing: registry.standing,
    /** The account's workers.dev subdomain, from which a stage Worker's origin follows. */
    subdomain: noArguments("subdomain", () => send({ kind: "account", operation: "subdomain" })),
    /**
     * The image every container application in the account runs, and nothing else of it: the
     * scale test finds its frozen pool image here. No row is returned, so none can be changed.
     */
    imageReferences: noArguments("imageReferences", () =>
      send({ kind: "account", operation: "imageReferences" }),
    ),
  });
}
