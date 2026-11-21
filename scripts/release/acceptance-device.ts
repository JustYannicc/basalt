import { Data, Exit, Schema } from "effect";
import type { ModelAuth } from "../pool-acceptance/client.ts";
import { HttpStatusFailure, UserCapReached } from "../pool-acceptance/types.ts";
import { nativeModelHeader, nativeModelPrefix } from "../../src/pool/native-contract.ts";
import { hostAssertionTtlMs, isSigningKey, signEnvelope } from "../../src/pool/token.ts";

/**
 * The registered models-only device release acceptance signs for, as the tools service's edge
 * signs for a person's device (src/native-model.ts). Its ids come from a masked secret and, like the
 * signing key, never reach a public line.
 */
export const AcceptanceDevice = Schema.Struct({
  computer: Schema.NonEmptyString,
  grant: Schema.NonEmptyString.check(Schema.isStartingWith("native:")),
  user: Schema.NonEmptyString,
  pool: Schema.NonEmptyString,
});
export type AcceptanceDevice = typeof AcceptanceDevice.Type;
const decodeDevice = Schema.decodeUnknownExit(Schema.fromJsonString(AcceptanceDevice));

/**
 * One assertion's lifetime, which is also its replay window: the pool binds method and path, not
 * the body, and keeps no nonce. It must outlive the pool's own replay: a release restarts the
 * controller, and the pool sends a held model call to the new one with the same headers up to
 * `controllerReplayWindowMs` (20 s, src/pool/controller-reset.ts) after its first attempt, plus the
 * hop. So it is the edge's lifetime, 25 s; the pool refuses one that expires more than 30 s past its
 * own clock, which leaves 5 s for a runner clock ahead of the pool's.
 */
export const acceptanceAssertionTtlMs = hostAssertionTtlMs;

/** The entry's exit when nothing was tested; release.yml's accept step reads it. */
export const COULD_NOT_TEST_EXIT = 4;

/** What to fix about the acceptance identity. Every field is public; its ids and the key never are. */
export class AcceptanceDeviceRefused extends Data.TaggedError("AcceptanceDeviceRefused")<{
  readonly field: string;
  readonly why: string;
  readonly fix: string;
}> {}
const misnamed = (why: string) =>
  new AcceptanceDeviceRefused({
    field: "POOL_ACCEPTANCE_DEVICE",
    why,
    fix: "set the POOL_ACCEPTANCE_DEVICE secret to the device's JSON: computer, grant, user and pool",
  });

/**
 * The pool's own refusal of the acceptance device: unknown or removed (401), models off or no
 * longer allowed (403), or its user's cap on a model turn (429 with the pool's cap code). Any other
 * 429 is a provider's, passed through, or comes from `/v1/models`, which no cap refuses: the pool not
 * serving.
 */
export const deviceRefusal = (error: unknown): number | undefined =>
  error instanceof UserCapReached ||
  (error instanceof HttpStatusFailure && (error.status === 401 || error.status === 403))
    ? error.status
    : undefined;

/**
 * A device its person revoked (410). Never "could not test" and never the pool not serving: a
 * release must fail on it, not stop as untested or start a restart without a boot to compare.
 */
export const deviceRevoked = (error: unknown) =>
  error instanceof HttpStatusFailure && error.status === 410;

/** What to check when the pool refused the device with these statuses. */
export const refusalFix = (statuses: readonly number[]) =>
  statuses.length && statuses.every((status) => status === 429)
    ? "the release's acceptance device hit its user's cap: check the cap, then run again"
    : "the release's acceptance device was refused: check that it is still registered and allowed";

export const refusedDevice = (status: number) =>
  new AcceptanceDeviceRefused({
    field: "POOL_ACCEPTANCE_DEVICE",
    why: `the pool refused it (HTTP ${status})`,
    fix: refusalFix([status]),
  });

/**
 * The key acceptance signs with. Mid-rotation the Worker serving before the apply knows only the
 * previous key, and the one after it accepts the previous key too (src/pool/token.ts openEnvelope).
 */
export function acceptanceSigningKey(env: NodeJS.ProcessEnv) {
  // A blank previous key is an unset one: outside a rotation the secret may hold only whitespace.
  const previous = env.POOL_APP_SIGNING_KEY_PREVIOUS?.trim();
  const key = previous || env.POOL_APP_SIGNING_KEY || "";
  if (!isSigningKey(key))
    throw new AcceptanceDeviceRefused({
      field: previous ? "POOL_APP_SIGNING_KEY_PREVIOUS" : "POOL_APP_SIGNING_KEY",
      why: "unset or not 32 bytes of lowercase hex",
      fix: "give the step the pool's app signing key",
    });
  return key;
}

/** The registered acceptance device `POOL_ACCEPTANCE_DEVICE` names. */
export function acceptanceDevice(env: NodeJS.ProcessEnv): AcceptanceDevice {
  const raw = env.POOL_ACCEPTANCE_DEVICE?.trim();
  if (!raw) throw misnamed("unset");
  // The decode error quotes the value, so only the verdict leaves here.
  const decoded = decodeDevice(raw);
  if (Exit.isFailure(decoded)) throw misnamed("malformed");
  return decoded.value;
}

/**
 * Signs one fresh assertion per model request, bound to that request's method and path with its
 * query. Release acceptance's boot and accept commands and the fleet lane's model calls make one.
 */
export function acceptanceCredential(
  env: NodeJS.ProcessEnv,
  now: () => number = Date.now,
): ModelAuth {
  const { computer, grant, user, pool } = acceptanceDevice(env);
  const key = acceptanceSigningKey(env);
  return async (method, path) => ({
    [nativeModelHeader]: await signEnvelope(key, nativeModelPrefix, {
      user,
      grant,
      computer,
      pool,
      method,
      path,
      expiresAt: now() + acceptanceAssertionTtlMs,
    }),
  });
}
