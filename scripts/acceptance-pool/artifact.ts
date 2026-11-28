import { createHash } from "node:crypto";

/**
 * What a run keeps in its files and step summary. This repository's runs can be read by anyone
 * signed in, so a receipt names its pool app and accounts only by these digests. The route answers
 * the ids themselves to a signed caller only: a later run that needs the app reads it by a signed
 * verify and checks it against `appSha256` from the run it continues.
 */
export const receiptIdSha256 = (kind: "app" | "account", id: string) =>
  createHash("sha256").update(`basalt-acceptance-pool-${kind}-v1\n${id}`).digest("hex");

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]) =>
  allowed.find((entry) => entry === value);
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const flag = (value: unknown) => (typeof value === "boolean" ? value : undefined);
const hex64 = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
const checkName = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;

function keptReceipt(receipt: Record<string, unknown>) {
  const { app, accounts } = receipt;
  return {
    migration: oneOf(receipt.migration, [
      "acceptance-pool-setup-v1",
      "acceptance-pool-teardown-v1",
    ]),
    organization: oneOf(receipt.organization, ["acceptance"]),
    status: oneOf(receipt.status, ["applied", "incomplete"]),
    appSha256: typeof app === "string" ? receiptIdSha256("app", app) : undefined,
    accountsSha256: Array.isArray(accounts)
      ? accounts.map((id) => (typeof id === "string" ? receiptIdSha256("account", id) : null))
      : undefined,
  };
}

const defined = (fields: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

/**
 * An operation's answer as a run may keep it: each field it names, in the shape that field has, and
 * the receipt without ids. Anything else the answer holds, now or in a later server, stays out.
 */
export function keptResult(result: Record<string, unknown>) {
  const { artifact, verification } = result;
  return defined({
    action: oneOf(result.action, ["dry-run", "apply", "verify"]),
    kind: oneOf(result.kind, ["setup", "teardown"]),
    planSha256: hex64(result.planSha256),
    // The dry run's plan, sealed to the recipient, which a later apply sends back as it came.
    artifact: record(artifact)
      ? defined({
          version: artifact.version,
          sha256: hex64(artifact.sha256),
          sealed: artifact.sealed,
          recipient: artifact.recipient,
        })
      : undefined,
    steps: count(result.steps),
    writes: count(result.writes),
    upstreamConfigured: oneOf(result.upstreamConfigured, ["yes", "no"]),
    repeated: flag(result.repeated),
    resumed: flag(result.resumed),
    completed: flag(result.completed),
    verification: record(verification)
      ? defined({
          ok: flag(verification.ok),
          checks: record(verification.checks)
            ? Object.fromEntries(
                Object.entries(verification.checks).filter(
                  ([name, value]) => checkName.test(name) && typeof value === "boolean",
                ),
              )
            : undefined,
        })
      : undefined,
    receipt: record(result.receipt) ? defined(keptReceipt(result.receipt)) : undefined,
  });
}
