import { automaticBudgetKey } from "./automatic-authority.ts";
import { consumeAutomaticAttempt, finishAutomaticAttempt } from "./automatic-recovery.ts";
import {
  LaunchRefused,
  sameLaunchTarget,
  LaunchTarget,
  launchGeneration,
  launchOperationId,
} from "./launch-contract.ts";
import { LaunchLedger, type LaunchStorage } from "./launch-ledger.ts";
import type { PoolLifecycle, PoolStatus } from "./lifecycle.ts";
import type { NativeMemberships } from "./membership.ts";
import type { NativeMembershipPolicy } from "./membership-contract.ts";
import {
  stoppedSelection,
  validateStoppedApproval,
  type StoppedApproval,
} from "./stopped-approval.ts";

const StoppedReceipt = Schema.Struct({
  action: Schema.Literal("start-stopped"),
  operationId: launchOperationId,
  target: LaunchTarget,
  generation: launchGeneration,
  status: Schema.Literals(["started", "ready", "failed"]),
  startedAt: Schema.Int,
  finishedAt: Schema.optional(Schema.Int),
  bootId: Schema.optional(launchOperationId),
  failure: Schema.optional(Schema.Literal("post-start-guard")),
});
export type StoppedReceipt = typeof StoppedReceipt.Type;
const decodeReceipt = (value: unknown) => {
  const receipt = Schema.decodeUnknownSync(StoppedReceipt, { onExcessProperty: "error" })(value);
  if (
    receipt.status !== "started" &&
    (receipt.finishedAt === undefined ||
      receipt.finishedAt < receipt.startedAt ||
      (receipt.status === "ready" && !receipt.bootId))
  )
    throw new LaunchRefused("receipt-invalid");
  return receipt;
};
interface Dependencies {
  storage: LaunchStorage;
  ledger: LaunchLedger;
  lifecycle: Pick<PoolLifecycle, "startStopped">;
  running(): boolean;
  status(): Promise<PoolStatus>;
  observeStopped(): Promise<{
    target: LaunchTarget;
    generation: number;
    state: string;
    observedAt: number;
  }>;
  memberships: Pick<NativeMemberships, "proveAll">;
  // These must address the bound runtime directly, without joining lifecycle.warm().
  restorePolicies(): Promise<void>;
  checkPolicy(policy: NativeMembershipPolicy, signal: AbortSignal): Promise<void>;
  now?: () => number;
}

/** Unbound by the live Worker. Destruction is deliberately absent from this capability. */
export class StoppedRecovery {
  private pending: Promise<unknown> = Promise.resolve();
  private deps: Dependencies;
  private enabled: boolean;
  constructor(deps: Dependencies, enabled = false) {
    this.deps = deps;
    this.enabled = enabled;
  }

  async inspect(id?: string) {
    if (id !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))
      throw new LaunchRefused("operation-id-invalid");
    return {
      enabled: this.enabled,
      running: this.deps.running(),
      launch: await this.deps.ledger.inspect(),
      ...(id ? { receipt: await this.receipt(id) } : {}),
    };
  }

  run(input: StoppedApproval): Promise<StoppedReceipt> {
    const result = this.pending.then(() => this.start(input));
    this.pending = result.catch(() => {});
    return result;
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private key(id: string) {
    return `runtime-recovery-v1:${id}`;
  }

  private async receipt(id: string) {
    const value = await this.deps.storage.get<unknown>(this.key(id));
    return value === undefined ? undefined : decodeReceipt(value);
  }

  private async start(input: StoppedApproval) {
    if (!this.enabled) throw new LaunchRefused("stopped-recovery-disabled");
    const approval = validateStoppedApproval(input, this.now());
    const previous = await this.receipt(approval.operationId);
    if (previous) {
      if (
        previous.operationId !== approval.operationId ||
        previous.generation !== approval.generation + 1 ||
        !sameLaunchTarget(previous.target, approval.target)
      )
        throw new LaunchRefused("operation-target-drift");
      return previous;
    }
    if (approval.selection !== (await stoppedSelection(approval.target, approval.generation)))
      throw new LaunchRefused("stopped-selection-mismatch");
    const started: StoppedReceipt = {
      action: "start-stopped",
      operationId: approval.operationId,
      target: approval.target,
      generation: approval.generation + 1,
      status: "started",
      startedAt: this.now(),
    };
    let oldBoot: string | undefined;
    let consumed = false;
    let completed: StoppedReceipt | undefined;
    const finish = async (receipt: StoppedReceipt) => {
      await this.deps.storage.put(this.key(approval.operationId), receipt);
      await this.deps.storage.put(
        automaticBudgetKey,
        finishAutomaticAttempt(
          await this.deps.storage.get(automaticBudgetKey),
          approval.operationId,
          receipt.status === "ready" ? "ready" : "failed",
        ),
      );
      completed = receipt;
    };
    await this.deps.lifecycle.startStopped(
      approval,
      async () => {
        validateStoppedApproval(approval, this.now());
        if (this.deps.running()) throw new LaunchRefused("runtime-no-longer-stopped");
        const current = await this.deps.ledger.check(approval);
        if (!current.bootId) throw new LaunchRefused("no-trusted-previous-boot");
        oldBoot = current.bootId;
        const observed = await this.deps.observeStopped();
        if (
          observed.state !== "stopped" ||
          !Number.isSafeInteger(observed.observedAt) ||
          observed.observedAt > this.now() ||
          this.now() - observed.observedAt > 30_000 ||
          observed.generation !== approval.generation ||
          !sameLaunchTarget(observed.target, approval.target)
        )
          throw new LaunchRefused("stopped-observation-mismatch");
        validateStoppedApproval(approval, this.now());
        await this.deps.storage.put(
          automaticBudgetKey,
          consumeAutomaticAttempt(
            await this.deps.storage.get(automaticBudgetKey),
            { operationId: approval.operationId, instanceId: approval.target.instanceId },
            this.now(),
          ),
        );
        await this.deps.storage.put(this.key(approval.operationId), started);
        consumed = true;
      },
      async (status) => {
        if (!consumed) throw new LaunchRefused("started-receipt-missing");
        try {
          if (status.boot_id === oldBoot) throw new LaunchRefused("boot-unchanged");
          await this.deps.restorePolicies();
          await this.deps.memberships.proveAll(
            (policy) => this.deps.checkPolicy(policy, AbortSignal.timeout(2_000)),
            async (assertCurrent) => {
              const fresh = await this.deps.status();
              if (
                !this.deps.running() ||
                fresh.boot_id !== status.boot_id ||
                !fresh.policyLeaseUntil ||
                fresh.policyLeaseUntil <= performance.now()
              )
                throw new LaunchRefused("post-start-health-mismatch");
              await this.deps.ledger.verify(fresh);
              if (!this.deps.running() || fresh.policyLeaseUntil <= performance.now())
                throw new LaunchRefused("post-start-health-expired");
              assertCurrent();
              await finish({
                ...started,
                status: "ready",
                bootId: fresh.boot_id,
                finishedAt: this.now(),
              });
            },
          );
        } catch (error) {
          // An unknown write outcome must keep the started budget until an operator inspects it.
          if (error instanceof LaunchRefused)
            await finish({
              ...started,
              status: "failed",
              failure: "post-start-guard",
              finishedAt: this.now(),
            });
          else throw error;
        }
      },
      async () => {
        validateStoppedApproval(approval, this.now());
        const record = await this.deps.ledger.check({
          ...approval,
          generation: started.generation,
        });
        if (record.operationId !== approval.operationId)
          throw new LaunchRefused("operation-target-drift");
      },
    );
    if (!completed) throw new LaunchRefused("completion-unproven");
    return completed;
  }
}
import { Schema } from "effect";
