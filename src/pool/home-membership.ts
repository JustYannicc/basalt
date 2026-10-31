import { HomeClient, PoolHome } from "./control.ts";
import { BackendFailure } from "./json.ts";

/** Replace only a pool's channel memberships. The saved credential and other pools survive. */
export class HomeMembership {
  private client: HomeClient;
  constructor(client: HomeClient) { this.client = client; }
  async actual(pool: string): Promise<readonly string[]> {
    this.client.invalidateGroups();
    return (await new PoolHome(this.client, pool).membership()).members.map((member) => member.auth_id);
  }
  async reconcile(pool: string, accounts: readonly string[]): Promise<void> {
    this.client.invalidateGroups();
    const home = new PoolHome(this.client, pool);
    const membership = await home.membership();
    const wanted = new Set(accounts);
    for (const member of membership.members) {
      if (wanted.has(member.auth_id)) continue;
      const response = await this.client.response(`/channel-group-details/${member.id}`, { method: "DELETE" });
      await response.body?.cancel();
      if (!response.ok && response.status !== 404) throw new BackendFailure(response.status);
    }
    await home.add([...wanted]);
  }
}
