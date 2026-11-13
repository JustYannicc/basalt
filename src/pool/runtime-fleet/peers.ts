import { Schema } from "effect";
import { HomePeerSource, peerTarget } from "../runtime-slots/peer-access.ts";
import { homePeerUpgrade } from "../home-peer-transport.ts";
import {
  SlotRefused,
  sameIdentity,
  sameTarget,
  type SlotIdentity,
  type SlotTarget,
} from "../runtime-slots/contract.ts";

export interface HomePeerEndpoint {
  homePeerSource(target: SlotTarget): Promise<HomePeerSource>;
  assertHomePeer(source: HomePeerSource): Promise<void>;
  fetch(request: Request): Promise<Response>;
}
interface Dependencies {
  controllerId: string;
  legacy(): Promise<SlotIdentity | undefined>;
  rows(): Promise<readonly { target: SlotTarget; phase: string }[]>;
  endpoint(target: SlotTarget): HomePeerEndpoint;
}

/** Ownership is resolved by the controller; a peer ordinal never selects or starts an arbitrary DO. */
export class RuntimeFleetPeers {
  private deps: Dependencies;
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  async open(input: HomePeerSource, ordinal: number) {
    const source = Schema.decodeUnknownSync(HomePeerSource, { onExcessProperty: "error" })(input);
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 128)
      throw new SlotRefused("identity");
    const sourceTarget = peerTarget(source);
    if (sourceTarget.controllerId !== this.deps.controllerId) throw new SlotRefused("identity");
    const legacy = await this.deps.legacy();
    const rows = (await this.deps.rows()).filter((row) =>
      ["warming", "uncertain", "ready", "draining"].includes(row.phase),
    );
    if (source.kind === "legacy") {
      if (!legacy || !sameIdentity(legacy, source.identity)) throw new SlotRefused("identity");
    } else if (!rows.some((row) => sameTarget(row.target, sourceTarget)))
      throw new SlotRefused("identity");
    await this.deps.endpoint(sourceTarget).assertHomePeer(source);
    const target =
      ordinal === 0 ? legacy : rows.find((row) => row.target.homePeerOrdinal === ordinal)?.target;
    if (!target || target.controllerId !== this.deps.controllerId)
      throw new SlotRefused("identity");
    const endpoint = this.deps.endpoint(target);
    const destination = await endpoint.homePeerSource(target);
    if (!sameTarget(peerTarget(destination), target)) throw new SlotRefused("identity");
    return endpoint.fetch(homePeerUpgrade(destination));
  }
}
