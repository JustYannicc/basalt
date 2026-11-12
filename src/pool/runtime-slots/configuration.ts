import { Schema } from "effect";
import { poolDatabase } from "../database-settings.ts";

export const RuntimeConfiguration = Schema.Struct({
  databaseUrl: Schema.String,
  managementKey: Schema.String,
  signingKey: Schema.String,
  previousSigningKey: Schema.optional(Schema.String),
  imageInput: Schema.String,
  databaseOwner: Schema.Literal(poolDatabase.owner),
  homePeerOrdinal: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 128 })),
  ),
});
export type RuntimeConfiguration = typeof RuntimeConfiguration.Type;
export interface RuntimeEnvironment {
  POOL_DATABASE_URL: string;
  POOL_MANAGEMENT_KEY: string;
  POOL_APP_SIGNING_KEY: string;
  POOL_APP_SIGNING_KEY_PREVIOUS?: string;
  POOL_IMAGE_HASH: string;
  POOL_DEPLOYMENT_KEY?: string;
  POOL_HOME_PEER_ORDINAL?: string;
}
export function runtimeConfiguration(env: RuntimeEnvironment): RuntimeConfiguration {
  return Schema.decodeUnknownSync(RuntimeConfiguration)({
    databaseUrl: env.POOL_DATABASE_URL,
    managementKey: env.POOL_MANAGEMENT_KEY,
    signingKey: env.POOL_APP_SIGNING_KEY,
    ...(env.POOL_APP_SIGNING_KEY_PREVIOUS
      ? { previousSigningKey: env.POOL_APP_SIGNING_KEY_PREVIOUS }
      : {}),
    imageInput: env.POOL_IMAGE_HASH,
    databaseOwner: poolDatabase.owner,
    ...(env.POOL_HOME_PEER_ORDINAL !== undefined
      ? { homePeerOrdinal: Number(env.POOL_HOME_PEER_ORDINAL) }
      : {}),
  });
}
export interface StartupOptions {
  enableInternet: boolean;
  env: Record<string, string>;
}
export function runtimeStartOptions(value: RuntimeConfiguration): StartupOptions {
  return {
    enableInternet: true,
    env: {
      POOL_DATABASE_URL: value.databaseUrl,
      POOL_DATABASE_SCHEMA_OWNER: value.databaseOwner,
      POOL_MANAGEMENT_KEY: value.managementKey,
      POOL_MANAGEMENT_ALLOW_REMOTE: "true",
      POOL_APP_SIGNING_KEY: value.signingKey,
      ...(value.homePeerOrdinal !== undefined
        ? { POOL_HOME_PEER_ORDINAL: String(value.homePeerOrdinal) }
        : {}),
      ...(value.previousSigningKey
        ? { POOL_APP_SIGNING_KEY_PREVIOUS: value.previousSigningKey }
        : {}),
    },
  };
}
export async function startupOptionsFingerprint(options: StartupOptions) {
  // Launch credentials have their own generation/token binding, separate from stable startup settings.
  const env = Object.fromEntries(
    Object.entries(options.env)
      .filter(([key]) => key !== "POOL_LAUNCH_GENERATION" && key !== "POOL_LAUNCH_TOKEN")
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  return Buffer.from(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify({
          enableInternet: options.enableInternet,
          env,
        }),
      ),
    ),
  ).toString("hex");
}
export async function configurationDigest(value: RuntimeConfiguration) {
  return startupOptionsFingerprint(
    runtimeStartOptions(Schema.decodeUnknownSync(RuntimeConfiguration)(value)),
  );
}
async function key(secret: string) {
  if (!/^[a-f0-9]{64}$/u.test(secret)) throw new Error("Runtime configuration key unavailable");
  return crypto.subtle.importKey("raw", Buffer.from(secret, "hex"), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
/** Runtime settings outlive controller code. Their plaintext never enters a receipt. */
export async function sealConfiguration(
  value: RuntimeConfiguration,
  secret: string,
  target: string,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(target) },
    await key(secret),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return {
    iv: Buffer.from(iv).toString("hex"),
    ciphertext: Buffer.from(ciphertext).toString("hex"),
  };
}
export async function openConfiguration(
  sealed: { iv: string; ciphertext: string },
  secret: string,
  target: string,
) {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Buffer.from(sealed.iv, "hex"),
      additionalData: new TextEncoder().encode(target),
    },
    await key(secret),
    Buffer.from(sealed.ciphertext, "hex"),
  );
  return Schema.decodeUnknownSync(RuntimeConfiguration)(
    JSON.parse(new TextDecoder().decode(plaintext)),
  );
}
