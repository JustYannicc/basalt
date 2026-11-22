/**
 * Registers a rehearsal stage's acceptance device: the models-only native device its release
 * acceptance signs for, in the stage pool's own registry, through the pool's normal registration
 * (`/native/v1/control`, src/pool/native-computers.ts). A person's device gets its setup intent from
 * their pool and its grant from the tools service. A rehearsal stage holds no people's pools, so this
 * signs both with the stage's own app signing key, which the stage run provides.
 *
 *   POOL_APP_SIGNING_KEY=<the stage's own> node scripts/release/rehearsal-acceptance-device.ts \
 *     --stage test-rehearsal-<n> --origin https://<stage app host> \
 *     --pool <id> --owner <id> --organization <id> --user <id>
 *
 * Prints the device's ids as JSON, for the stage run's POOL_ACCEPTANCE_DEVICE. The device's model
 * key stays sealed in the pool.
 */
import { parseArgs } from "node:util";
import { appHosting, brand } from "../../brand.ts";
import { nativeControlPath, nativeControlPrefix } from "../../src/pool/native-contract.ts";
import { setupTtl, signIntent } from "../../src/pool/setup-links.ts";
import { hostAssertionTtlMs, isSigningKey, signEnvelope } from "../../src/pool/token.ts";
import type { AcceptanceDevice } from "./acceptance-device.ts";
import { isRehearsalStage } from "./rehearsal-stage.ts";

export interface RehearsalDeviceInput {
  readonly stage: string;
  readonly origin: string;
  readonly signingKey: string;
  readonly pool: string;
  readonly owner: string;
  readonly organization: string;
  readonly user: string;
}

/** First, before anything is read or sent: on production a forged intent would be a real one. */
function rehearsalOnly(stage: string) {
  if (stage === "production")
    throw new Error("A rehearsal acceptance device is never registered on production");
  if (!isRehearsalStage(stage))
    throw new Error("Register a rehearsal acceptance device only on a test-rehearsal-<n> stage");
}

/**
 * The stage's own https origin. Its host carries the stage's DNS label (`rehearsal-<n>`, the stage
 * without `test-`, as deploy.ts labels a stage's hostnames) as one whole label. Our rehearsal
 * stages share production's zone, so under that zone exactly one host is admitted: the stage's own
 * app host, `app.rehearsal-<n>.<zone>`. Production's own hosts, and anything else under its zone,
 * are refused.
 */
function stageOrigin(stage: string, value: string) {
  const origin = URL.parse(value);
  if (origin?.protocol !== "https:") throw new Error("Give the stage's https origin");
  // URL lowercases the host; one trailing dot names the same host, an empty label names none.
  if (origin.hostname.endsWith("..") || origin.hostname.includes(".."))
    throw new Error("The origin's host has an empty label");
  const host = origin.hostname.replace(/\.$/u, "");
  const label = stage.replace(/^test-/u, "");
  const production = new Set([
    brand.zone,
    brand.host,
    `www.${brand.zone}`,
    ...appHosting.bypassHosts,
  ]);
  if (
    production.has(host) ||
    ((host === brand.zone || host.endsWith(`.${brand.zone}`)) &&
      host !== `app.${label}.${brand.zone}`)
  )
    throw new Error("The origin is production's host or under its zone");
  if (!host.split(".").includes(stage.replace(/^test-/u, "")))
    throw new Error("The origin's host does not carry the stage's label (rehearsal-<n>)");
  origin.hostname = host;
  return origin;
}

export async function registerRehearsalAcceptanceDevice(
  input: RehearsalDeviceInput,
  send: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<AcceptanceDevice> {
  rehearsalOnly(input.stage);
  const origin = stageOrigin(input.stage, input.origin);
  if (!isSigningKey(input.signingKey))
    throw new Error("The stage's signing key must be 32 bytes of lowercase hex");
  const { pool, owner, organization, user } = input;
  if (![pool, owner, organization, user].every((value) => value.trim()))
    throw new Error("Name the stage pool, its owner and organization, and the device's user");
  const at = now();
  const grant = `native:rehearsal-acceptance-${crypto.randomUUID()}`;
  const intent = await signIntent(input.signingKey, {
    pool,
    owner,
    organization,
    user,
    expiresAt: at + setupTtl,
  });
  const envelope = await signEnvelope(input.signingKey, nativeControlPrefix, {
    action: "register",
    user,
    grant,
    name: "Release acceptance",
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
    throw new Error(`The stage pool refused the registration (HTTP ${response.status})`);
  }
  const reply = (await response.json()) as { computer?: { id?: unknown }; pool?: unknown };
  const computer = reply.computer?.id;
  if (typeof computer !== "string" || !computer || reply.pool !== pool)
    throw new Error("The stage pool's registration reply named no device in this pool");
  return { computer, grant, user, pool };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: Object.fromEntries(
      ["stage", "origin", "pool", "owner", "organization", "user"].map((name) => [
        name,
        { type: "string" as const, default: "" },
      ]),
    ),
  });
  const device = await registerRehearsalAcceptanceDevice({
    stage: String(values.stage),
    origin: String(values.origin),
    signingKey: process.env.POOL_APP_SIGNING_KEY ?? "",
    pool: String(values.pool),
    owner: String(values.owner),
    organization: String(values.organization),
    user: String(values.user),
  });
  console.log(JSON.stringify(device));
}
