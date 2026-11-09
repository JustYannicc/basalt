import { Schema } from "effect";
import { automaticBudgetKey } from "./automatic-authority.ts";
import { decodeAutomaticBudget } from "./automatic-recovery.ts";
import type { PoolStatus } from "./lifecycle.ts";
import {
  LaunchRecord,
  LaunchTarget,
  LaunchRefused,
  sameLaunchTarget,
  launchOperationId,
  type LaunchExpectation,
} from "./launch-contract.ts";

export const launchStorageKey = "runtime-recovery-v1:launch";
export interface LaunchStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
}
const parseRecord = Schema.decodeUnknownSync(LaunchRecord, { onExcessProperty: "error" });
const decodeRecord = (value: unknown) => {
  try {
    return parseRecord(value);
  } catch {
    throw new LaunchRefused("launch-state-invalid");
  }
};
const decodeTarget = Schema.decodeUnknownSync(LaunchTarget, { onExcessProperty: "error" });
export async function launchTokenHash(token: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Only the lifecycle queue may prepare or acknowledge a launch. Inspection omits its token. */
export class LaunchLedger {
  private storage: LaunchStorage;
  private readTarget: () => Promise<LaunchTarget>;
  constructor(storage: LaunchStorage, readTarget: () => Promise<LaunchTarget>) {
    this.storage = storage;
    this.readTarget = readTarget;
  }

  async current() {
    const value = await this.storage.get<unknown>(launchStorageKey);
    return value === undefined ? undefined : decodeRecord(value);
  }

  async inspect() {
    const record = await this.current();
    if (!record) return undefined;
    const { token: _token, ...safe } = record;
    return safe;
  }

  async check(expected: LaunchExpectation) {
    const record = await this.current();
    const target = decodeTarget(await this.readTarget());
    if (!record || record.generation !== expected.generation)
      throw new LaunchRefused("launch-generation-drift");
    if (
      !sameLaunchTarget(record.target, expected.target) ||
      !sameLaunchTarget(target, expected.target)
    )
      throw new LaunchRefused("release-target-drift");
    return record;
  }

  async prepare(expected?: LaunchExpectation, intent?: "restart"): Promise<LaunchRecord> {
    const previous = expected ? await this.check(expected) : await this.current();
    if (!expected && intent !== "restart") {
      const retained = await this.storage.get<unknown>(automaticBudgetKey);
      if (
        (previous && !previous.bootId) ||
        (retained !== undefined &&
          decodeAutomaticBudget(retained).attempts.some((attempt) => attempt.status === "started"))
      )
        throw new LaunchRefused("launch-result-uncertain");
    }
    const target = decodeTarget(await this.readTarget());
    if (expected && !sameLaunchTarget(target, expected.target))
      throw new LaunchRefused("release-target-drift");
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const record = decodeRecord({
      target,
      generation: (previous?.generation ?? 0) + 1,
      operationId: expected?.operationId ?? crypto.randomUUID(),
      token,
    });
    await this.storage.put(launchStorageKey, record);
    return record;
  }

  async verify(status: PoolStatus) {
    const record = await this.current();
    if (!record) throw new LaunchRefused("launch-generation-missing");
    await this.check({ ...record, operationId: record.operationId });
    if (
      !status.policyLeaseUntil ||
      status.policyLeaseUntil <= performance.now() ||
      status.launch?.generation !== record.generation ||
      status.launch.tokenHash !== (await launchTokenHash(record.token))
    )
      throw new LaunchRefused("launch-readiness-mismatch");
    const bootId = Schema.decodeUnknownSync(launchOperationId)(status.boot_id);
    if (!bootId) throw new LaunchRefused("boot-identity-missing");
    if (!status.policyLeaseUntil || status.policyLeaseUntil <= performance.now())
      throw new LaunchRefused("launch-health-expired");
    if (record.bootId !== bootId) await this.storage.put(launchStorageKey, { ...record, bootId });
  }
}
