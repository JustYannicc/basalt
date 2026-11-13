import { Schema } from "effect";
import { createHash } from "node:crypto";

const hex = (length: number) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^[a-f0-9]{${length}}$`, "u")));
const uuid = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u),
);
const stage = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/u));

export const BootstrapTarget = Schema.Struct({
  operationId: uuid,
  connectionId: Schema.String.check(
    Schema.isPattern(/^acc_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u),
  ),
  accountId: hex(32),
  storeId: hex(32),
  stage,
});
export type BootstrapTarget = typeof BootstrapTarget.Type;
export const BootstrapPlan = Schema.Struct({
  version: Schema.Literal(1),
  target: BootstrapTarget,
  attemptId: uuid,
  mode: Schema.Literals(["create", "inspect", "rotate", "revoke"]),
  tokenId: Schema.NullOr(hex(32)),
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type BootstrapPlan = typeof BootstrapPlan.Type;
export const Approval = Schema.Struct({
  id: uuid,
  action: Schema.Literals(["mint", "store", "rotate", "revoke"]),
  coordinatorGo: Schema.Literal(true),
  writerLease: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9:-]{1,120}$/u)),
  planDigest: hex(64),
  programDigest: hex(64),
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type Approval = typeof Approval.Type;
export const BootstrapPacket = Schema.Struct({
  plan: BootstrapPlan,
  approvals: Schema.Array(Approval),
});
export type BootstrapPacket = typeof BootstrapPacket.Type;
export const Outcome = Schema.Literals([
  "stored",
  "absent",
  "owned_token",
  "revoked",
  "refused_target",
  "refused_inventory",
  "refused_ownership",
  "refused_existing",
  "unknown_read",
  "unknown_create",
  "unknown_store",
  "unknown_rotate",
  "unknown_revoke",
]);
export const BootstrapResult = Schema.Struct({
  tokenId: Schema.NullOr(hex(32)),
  secretName: Schema.String.check(
    Schema.isPattern(/^basalt-[a-z][a-z0-9-]{0,31}-pool-provider-observation$/u),
  ),
  outcome: Outcome,
});
export type BootstrapResult = typeof BootstrapResult.Type;

export class BootstrapRefusal extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Pool credential bootstrap refused: ${reason}`);
    this.reason = reason;
  }
}
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b, "en")));
  });
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const targetDigest = (target: BootstrapTarget) => digest(canonical(target));
export const planDigest = (plan: BootstrapPlan) => digest(canonical(plan));
export const secretName = (target: BootstrapTarget) =>
  `basalt-${target.stage}-pool-provider-observation`;
export const tokenName = (target: BootstrapTarget) =>
  `basalt-${target.stage}-pool-observation-${target.operationId}`;
export const decodePlan = Schema.decodeUnknownSync(BootstrapPlan, { onExcessProperty: "error" });
export const decodePacket = Schema.decodeUnknownSync(BootstrapPacket, {
  onExcessProperty: "error",
});
export const decodeResult = Schema.decodeUnknownSync(BootstrapResult, {
  onExcessProperty: "error",
});

export function validatePlan(plan: BootstrapPlan, now: number) {
  if (plan.expiresAt <= now || plan.expiresAt > now + 10 * 60_000)
    throw new BootstrapRefusal("operation-window-invalid");
  if (
    (plan.mode === "create" && plan.tokenId !== null) ||
    ((plan.mode === "rotate" || plan.mode === "revoke") && plan.tokenId === null)
  )
    throw new BootstrapRefusal("recovery-token-required");
}

export function validateApprovals(packet: BootstrapPacket, programDigest: string, now: number) {
  validatePlan(packet.plan, now);
  const actions =
    packet.plan.mode === "create"
      ? ["mint", "store"]
      : packet.plan.mode === "rotate"
        ? ["rotate", "store"]
        : packet.plan.mode === "revoke"
          ? ["revoke"]
          : [];
  const approvals = packet.approvals;
  if (
    approvals.length !== actions.length ||
    new Set(approvals.map((a) => a.id)).size !== approvals.length ||
    new Set(approvals.map((a) => a.action)).size !== approvals.length ||
    new Set(approvals.map((a) => a.writerLease)).size > 1 ||
    actions.some((action) => !approvals.some((a) => a.action === action)) ||
    approvals.some(
      (a) =>
        a.planDigest !== planDigest(packet.plan) ||
        a.programDigest !== programDigest ||
        a.expiresAt < packet.plan.expiresAt ||
        a.expiresAt <= now,
    )
  )
    throw new BootstrapRefusal("separate-exact-approvals-required");
}
