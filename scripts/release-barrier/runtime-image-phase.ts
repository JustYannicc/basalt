import type { FrozenContainer, ContainerAttributes } from "./container.ts";

export type FleetImageResource = "PoolRuntimeBlue" | "PoolRuntimeGreen";

/** Every application write has a controller freeze and a provider readback owned by the ordinary release. */
export interface RuntimeImagePhase {
  resource?: FleetImageResource;
  deferVerification?: boolean;
  prepare(container: FrozenContainer): Promise<void>;
  verify(container: FrozenContainer, observed: ContainerAttributes): Promise<void>;
}
