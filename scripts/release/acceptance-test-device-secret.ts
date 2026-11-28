/**
 * The test pool's device as the fleet lane and the load read it: its secret's shape and the
 * identity rule. Kept apart from the registration script, so a lane run loads none of the pool's
 * setup code.
 */
import { Exit, Schema } from "effect";
import { AcceptanceDevice, AcceptanceDeviceRefused } from "./acceptance-device.ts";

/** The user, owner and organization the acceptance-pool operation creates the test pool for. */
export const acceptanceIdentity = "acceptance";
export const testDeviceSecret = "POOL_ACCEPTANCE_TEST_DEVICE";

/** The test device's secret: the release device's ids plus the pool's owner and organization. */
export const AcceptanceTestDevice = Schema.Struct({
  ...AcceptanceDevice.fields,
  owner: Schema.NonEmptyString,
  organization: Schema.NonEmptyString,
});
export type AcceptanceTestDevice = typeof AcceptanceTestDevice.Type;
const decodeTestDevice = Schema.decodeUnknownExit(Schema.fromJsonString(AcceptanceTestDevice));

/**
 * Only for this identity may an owner token be minted: the pool's owner token then names an
 * organization that owns nothing but the test pool.
 */
export const isAcceptanceIdentity = (device: {
  readonly user: string;
  readonly owner: string;
  readonly organization: string;
}) =>
  device.user === acceptanceIdentity &&
  device.owner === acceptanceIdentity &&
  device.organization === acceptanceIdentity;

const refused = (why: string) =>
  new AcceptanceDeviceRefused({
    field: testDeviceSecret,
    why,
    fix: `set the ${testDeviceSecret} secret to the test device's JSON: computer, grant, user, pool, owner and organization`,
  });

/** The test device `POOL_ACCEPTANCE_TEST_DEVICE` names; unset is refused, never replaced. */
export function acceptanceTestDevice(env: NodeJS.ProcessEnv): AcceptanceTestDevice {
  const raw = env[testDeviceSecret]?.trim();
  if (!raw) throw refused("unset");
  // The decode error quotes the value, so only the verdict leaves here.
  const decoded = decodeTestDevice(raw);
  if (Exit.isFailure(decoded)) throw refused("malformed");
  return decoded.value;
}
