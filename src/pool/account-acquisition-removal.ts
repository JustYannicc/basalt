import type { HomeClient } from "./control.ts";
import { homeReferences } from "./home-references.ts";
import { unavailable } from "./json.ts";

export interface AcknowledgedRemoval {
  pool: string;
  references: readonly string[];
  actor: string;
  operation: string;
}

/** Acknowledge credentials before recording intent; an internal cleanup has no acting person. */
export async function removeHomeAccount(
  home: HomeClient,
  ref: string,
  input: {
    signal?: AbortSignal | undefined;
    actor?: string | undefined;
    operation?: string | undefined;
    acknowledged?: ((removal: AcknowledgedRemoval) => Promise<void>) | undefined;
  } = {},
): Promise<void> {
  const refs = homeReferences(ref);
  const before =
    input.actor && !input.actor.startsWith("organization:")
      ? await home.allMembership(input.signal)
      : undefined;
  for (const id of refs) {
    const response = await home.response(`/credentials?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
      signal: input.signal,
    });
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) return unavailable();
  }
  if (before && input.actor && input.operation) {
    for (const group of before.groups) {
      if (!group.channel_name.startsWith("signalbox-pool-")) continue;
      const references = before.members
        .filter((member) => member.channel_group_id === group.id && refs.includes(member.auth_id))
        .map((member) => member.auth_id);
      if (references.length)
        await input.acknowledged?.({
          pool: group.channel_name.slice("signalbox-pool-".length),
          references,
          actor: input.actor,
          operation: input.operation,
        });
    }
  }
  for (const member of (await home.allMembership(input.signal)).members.filter((member) =>
    refs.includes(member.auth_id),
  )) {
    const removed = await home.response(`/channel-group-details/${member.id}`, {
      method: "DELETE",
      signal: input.signal,
    });
    await removed.body?.cancel();
    if (!removed.ok && removed.status !== 404) return unavailable();
  }
}
