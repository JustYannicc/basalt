import { Data, Exit, Schema } from "effect";
import type { ModelAuth } from "../pool-acceptance/client.ts";
import { HttpStatusFailure } from "../pool-acceptance/types.ts";
import { nativeModelHeader, nativeModelPrefix } from "../../src/pool/native-contract.ts";
import { isSigningKey, signEnvelope } from "../../src/pool/token.ts";

/**
 * The registered models-only device release acceptance signs for, as the tools service's edge
 * signs for a person's device (src/native-model.ts). Its ids are not secret; the signing key is.
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
 * the body, and keeps no nonce. The pool refuses one that expires more than 30 s past its own clock,
 * and the signer is a runner, not the pool: 10 s leaves 20 s for a runner clock ahead of the pool's,
 * and 10 s for the hop plus a clock behind it. The edge signs with the pool's own clock and uses 25.
 */
export const acceptanceAssertionTtlMs = 10_000;

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
 * longer allowed (403), or a cap or rate limit on its user (429). It says nothing about whether the
 * release serves.
 */
export const deviceRefusal = (error: unknown): number | undefined =>
  error instanceof HttpStatusFailure && [401, 403, 429].includes(error.status)
    ? error.status
    : undefined;

/** What to check when the pool refused the device with these statuses. */
export const refusalFix = (statuses: readonly number[]) =>
  statuses.length && statuses.every((status) => status === 429)
    ? "the release's acceptance device hit its user's cap or a rate limit: check the cap, then run again"
    : "the release's acceptance device was refused: check that it is still registered and allowed";

export const refusedDevice = (status: number) =>
  new AcceptanceDeviceRefused({
    field: "POOL_ACCEPTANCE_DEVICE",
    why: `the pool refused it (HTTP ${status})`,
    fix: refusalFix([status]),
  });

/**
 * Signs one fresh assertion per model request, bound to that request's method and path with its
 * query. Only release acceptance's boot and accept commands make one.
 */
export function acceptanceCredential(
  env: NodeJS.ProcessEnv,
  now: () => number = Date.now,
): ModelAuth {
  const raw = env.POOL_ACCEPTANCE_DEVICE?.trim();
  if (!raw) throw misnamed("unset");
  // The decode error quotes the value, so only the verdict leaves here.
  const decoded = decodeDevice(raw);
  if (Exit.isFailure(decoded)) throw misnamed("malformed");
  const { computer, grant, user, pool } = decoded.value;
  // Mid-rotation the Worker serving before the apply knows only the previous key, and the one after
  // it accepts the previous key too (src/pool/token.ts openEnvelope).
  const key = env.POOL_APP_SIGNING_KEY_PREVIOUS || env.POOL_APP_SIGNING_KEY || "";
  if (!isSigningKey(key))
    throw new AcceptanceDeviceRefused({
      field: env.POOL_APP_SIGNING_KEY_PREVIOUS ? "POOL_APP_SIGNING_KEY_PREVIOUS" : "POOL_APP_SIGNING_KEY",
      why: "unset or not 32 bytes of lowercase hex",
      fix: "give the step the pool's app signing key",
    });
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
