import type { Computer } from "../../apps/pool/ui/computer-types.ts";
import type { SealedLink } from "./setup-links.ts";
import type { SealedNativeKey } from "./native-key.ts";

export interface StoredComputer {
  id: string;
  name: string;
  user: string;
  pool: string;
  createdAt: string;
  boundAt: string;
  state: "issuing" | "active" | "revoking" | "revoked" | "removed";
  keyId?: number;
  userId?: number;
  /** The model key stays on the server; only a live matching OAuth grant can use it. */
  native?: { grant: string; models: boolean; key?: SealedNativeKey; toolsOrganization?: string };
  /** Absent when the computer was set up for models only. */
  toolsKeyId?: string;
  toolsHash?: string;
  firstModelRequestAt: string | null;
  firstToolCallAt: string | null;
  revokedAt: string | null;
  firstModelRequestEverAt?: string | null;
  modelObservationCheckedAt?: number;
  modelObservationRetryAt?: number;
  setupCompletedAt?: string | null;
  removedAt?: string | null;
  removalPending?: boolean;
  removalAt?: number;
  switching?: string[];
  switchingTo?: string;
  link?: SealedLink;
  beforeRemoval?: { state: StoredComputer["state"]; link?: SealedLink };
  /** Upkeep revoked its Home keys; a web setup's tools token still waits for its deletion. */
  homeKeysRevokedAt?: string;
  /** Its person revoked it and its web setup's tools key is gone, deleted or found missing. */
  toolsKeyDeletedAt?: string;
  /** Why access removal finished it `removed`: during its person's revoke, or for lost access. */
  removedFor?: "revoke" | "access";
  /** Access was restored to a row that kept no record of its state before removal. */
  restoredWithoutHistory?: true;
}
export interface ComputerStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
}
export type Registry = Record<string, StoredComputer>;
export const publicView = (computer: StoredComputer): Computer => ({
  id: computer.id,
  name: computer.name,
  poolId: computer.pool,
  createdAt: computer.createdAt,
  state: computer.state,
  firstModelRequestAt: computer.firstModelRequestAt,
  firstToolCallAt: computer.firstToolCallAt,
  revokedAt: computer.revokedAt,
  removedAt: computer.removedAt ?? null,
  tools: hasTools(computer),
  ...(usesNoPool(computer) && { models: false }),
  // Unclaimed with its link gone: nobody can ever set it up, so the page may clear it.
  ...(computer.state === "issuing" && !computer.link && { lapsed: true }),
});

/** A models-only computer has no tools token. */
export const hasTools = (computer: {
  toolsKeyId?: string;
  native?: { toolsOrganization?: string };
}): boolean =>
  computer.toolsKeyId !== undefined || computer.native?.toolsOrganization !== undefined;

/**
 * A device approved for tools only. Its grant alone authorizes its tools and it holds nothing at
 * any pool; its row exists for Connect's list and revoke.
 */
export const usesNoPool = (computer: Pick<StoredComputer, "native">): boolean =>
  computer.native?.models === false;

/**
 * Include every destination whose backend write may have succeeded. A tools-only device has none,
 * so no pool's access change removes it.
 */
export const boundPools = (computer: StoredComputer): string[] =>
  usesNoPool(computer)
    ? []
    : [
        ...new Set([
          computer.pool,
          ...(computer.switching ?? []),
          ...(computer.switchingTo ? [computer.switchingTo] : []),
        ]),
      ];
