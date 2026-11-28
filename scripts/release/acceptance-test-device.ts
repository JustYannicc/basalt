/**
 * The test pool's device: a models-only native device registered in the pool the acceptance-pool
 * operation created, whose ids live in their own secret, `POOL_ACCEPTANCE_TEST_DEVICE`. The
 * release's device, `POOL_ACCEPTANCE_DEVICE`, is never read or written here.
 *
 *   POOL_APP_SIGNING_KEY=<key> node scripts/release/acceptance-test-device.ts register \
 *     --stage production --pool <app id> --owner acceptance --organization acceptance \
 *     --user acceptance --receipt <setup receipt file> --out <device file>
 *   POOL_APP_SIGNING_KEY=<key> node scripts/release/acceptance-test-device.ts revoke \
 *     --stage production --receipt <setup receipt file> --device <device file>
 *
 * A rehearsal stage takes `--stage test-rehearsal-<n> --origin <its app origin>` and its own key.
 * The device's ids go to the `--out` file only, never to a log; its model key stays sealed in the
 * pool. At teardown the device is revoked before the pool is deleted.
 */
import { open, readFile, unlink } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Exit, Schema } from "effect";
import { brand } from "../../brand.ts";
import { nativeControlPath, nativeControlPrefix } from "../../src/pool/native-contract.ts";
import { setupTtl, signIntent } from "../../src/pool/setup-links.ts";
import { hostAssertionTtlMs, isSigningKey, signEnvelope } from "../../src/pool/token.ts";
import { AcceptanceDevice, AcceptanceDeviceRefused } from "./acceptance-device.ts";
import { stageOrigin } from "./rehearsal-acceptance-device.ts";
import { isRehearsalStage } from "./rehearsal-stage.ts";

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

/** A tools-service pool app's id, the only kind of pool id production can have. */
const appPool = /^app_[A-Za-z0-9_-]{1,124}$/u;

/**
 * What this script reads of the acceptance-pool operation's setup receipt (carry 0816,
 * `private_production_ops_receipts`): which operation it records, for whom, that it was applied,
 * and the pool app it created.
 */
export const SetupReceipt = Schema.Struct({
  migration: Schema.Literal("acceptance-pool-setup-v1"),
  organization: Schema.Literal(acceptanceIdentity),
  status: Schema.Literal("applied"),
  app: Schema.String.check(Schema.isPattern(appPool)),
});
const decodeReceipt = Schema.decodeUnknownExit(SetupReceipt);

export interface TestPoolTarget {
  readonly stage: string;
  /** A rehearsal stage's app origin; production's is fixed. */
  readonly origin?: string;
  readonly signingKey: string;
  /** The setup receipt, as read from its file. */
  readonly receipt: unknown;
}

/**
 * First, before anything is signed or sent: the stage is production or a rehearsal, the identity is
 * the acceptance identity throughout, and the pool is the one the setup receipt names. A device for
 * a pool that holds people's work is never registered or revoked here.
 */
function admit(
  target: TestPoolTarget,
  claims: { pool: string; owner: string; organization: string; user: string },
) {
  if (target.stage !== "production" && !isRehearsalStage(target.stage))
    throw new Error("A test device is registered only on production or a test-rehearsal-<n> stage");
  if (!isAcceptanceIdentity(claims))
    throw new Error(
      "The test device's user, owner and organization must all be the acceptance identity",
    );
  const receipt = decodeReceipt(target.receipt);
  if (Exit.isFailure(receipt))
    throw new Error("The setup receipt is not an applied acceptance-pool setup for acceptance");
  if (claims.pool !== receipt.value.app)
    throw new Error("The pool is not the one the acceptance-pool setup receipt created");
  if (!isSigningKey(target.signingKey))
    throw new Error("The signing key must be 32 bytes of lowercase hex");
  if (target.stage === "production") {
    if (target.origin !== undefined && target.origin !== `https://${brand.host}`)
      throw new Error("On production the pool is reached at the product's own app host only");
    return new URL(`https://${brand.host}`);
  }
  return stageOrigin(target.stage, target.origin ?? "");
}

export async function registerAcceptanceTestDevice(
  target: TestPoolTarget & { pool: string; owner: string; organization: string; user: string },
  send: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<AcceptanceTestDevice> {
  const { pool, owner, organization, user } = target;
  const origin = admit(target, { pool, owner, organization, user });
  const at = now();
  const grant = `native:acceptance-test-${crypto.randomUUID()}`;
  const intent = await signIntent(target.signingKey, {
    pool,
    owner,
    organization,
    user,
    expiresAt: at + setupTtl,
  });
  const envelope = await signEnvelope(target.signingKey, nativeControlPrefix, {
    action: "register",
    user,
    grant,
    name: "Acceptance test",
    models: true,
    tools: false,
    intent,
    expiresAt: at + hostAssertionTtlMs,
  });
  const response = await send(new URL(nativeControlPath, origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope }),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`The test pool refused the registration (HTTP ${response.status})`);
  }
  const reply = (await response.json()) as { computer?: { id?: unknown }; pool?: unknown };
  const computer = reply.computer?.id;
  if (typeof computer !== "string" || !computer || reply.pool !== pool)
    throw new Error("The test pool's registration reply named no device in this pool");
  return { computer, grant, user, pool, owner, organization };
}

/** Revokes the test device, before the pool is deleted. A repeated revoke is answered the same. */
export async function revokeAcceptanceTestDevice(
  target: TestPoolTarget & { device: AcceptanceTestDevice },
  send: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  const { device } = target;
  const origin = admit(target, device);
  const envelope = await signEnvelope(target.signingKey, nativeControlPrefix, {
    action: "revoke",
    user: device.user,
    grant: device.grant,
    computer: device.computer,
    pool: device.pool,
    expiresAt: now() + hostAssertionTtlMs,
  });
  const response = await send(new URL(nativeControlPath, origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope }),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`The test pool refused the revoke (HTTP ${response.status})`);
  }
  const reply = (await response.json()) as { revoked?: unknown };
  if (reply.revoked !== true) throw new Error("The test pool did not confirm the revoke");
}

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8")) as unknown;

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: Object.fromEntries(
      ["stage", "origin", "pool", "owner", "organization", "user", "receipt", "out", "device"].map(
        (name) => [name, { type: "string" as const }],
      ),
    ),
  });
  const target = {
    stage: values.stage ?? "",
    ...(values.origin ? { origin: values.origin } : {}),
    signingKey: process.env.POOL_APP_SIGNING_KEY ?? "",
    receipt: await readJson(values.receipt ?? ""),
  };
  if (command === "register") {
    if (!values.out) throw new Error("Give --out, the file the device's ids are written to");
    // Created first, readable by its owner only, so a registered device's ids always have a place.
    const out = await open(values.out, "wx", 0o600);
    let device;
    try {
      device = await registerAcceptanceTestDevice({
        ...target,
        pool: values.pool ?? "",
        owner: values.owner ?? "",
        organization: values.organization ?? "",
        user: values.user ?? "",
      });
    } catch (error) {
      await out.close();
      await unlink(values.out);
      throw error;
    }
    // The ids go to the file alone.
    await out.writeFile(`${JSON.stringify(device)}\n`);
    await out.close();
    console.log("registered the test device; its ids are in the --out file");
  } else if (command === "revoke") {
    const device = decodeTestDevice(await readFile(values.device ?? "", "utf8"));
    if (Exit.isFailure(device)) throw new Error("The --device file is not a test device's JSON");
    await revokeAcceptanceTestDevice({ ...target, device: device.value });
    console.log("revoked the test device");
  } else throw new Error("Give register or revoke");
}
