import type { Computer } from "../../apps/pool/ui/computer-types.ts";
import type { SealedLink } from "./setup-links.ts";

export interface StoredComputer {
  id: string; name: string; user: string; pool: string; createdAt: string; boundAt: string;
  state: "issuing" | "active" | "revoking" | "revoked" | "removed";
  keyId?: number; userId?: number; toolsKeyId: string; toolsHash: string;
  firstModelRequestAt: string | null; firstToolCallAt: string | null; revokedAt: string | null;
  firstModelRequestEverAt?: string | null; modelObservationCheckedAt?: number; setupCompletedAt?: string | null;
  removedAt?: string | null; removalPending?: boolean; removalAt?: number; switching?: string[]; switchingTo?: string; link?: SealedLink;
  beforeRemoval?: { state: StoredComputer["state"]; link?: SealedLink };
}
export interface ComputerStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
}
export type Registry = Record<string, StoredComputer>;
export const publicView = (computer: StoredComputer): Computer => ({
  id: computer.id, name: computer.name, poolId: computer.pool, createdAt: computer.createdAt,
  state: computer.state, firstModelRequestAt: computer.firstModelRequestAt,
  firstToolCallAt: computer.firstToolCallAt, revokedAt: computer.revokedAt, removedAt: computer.removedAt ?? null,
});

/** Include every destination whose backend write may have succeeded. */
export const boundPools = (computer: StoredComputer): string[] =>
  [...new Set([computer.pool, ...(computer.switching ?? []), ...(computer.switchingTo ? [computer.switchingTo] : [])])];
