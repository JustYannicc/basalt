/**
 * Stand-ins for the two release-preflight-steps.ts imports that reach production: the Alchemy state
 * store's version endpoint and the Node bridge to PoolOperations. The read-only guard, the running
 * release read and every other step stay real; the bridge goes to the connection a test installs.
 */
import { Effect } from "effect";
import type { PoolOperationsTarget } from "../../pool-operations.ts";

export {
  readOnlyPoolOperations,
  readOnlyReleaseWriter,
  runningRelease,
} from "../release-preflight-guard.ts";

type Connect = NonNullable<PoolOperationsTarget["connect"]>;
let connect: Connect = async () => {
  throw new Error("No PoolOperations connection installed");
};
export const installPoolOperations = (next: Connect) => {
  connect = next;
};
export const nodeBridgeFromConfig: Connect = (path) => connect(path);

export const assertReleaseStateVersion = (..._args: unknown[]) => Effect.void;
