import { ownedByStage } from "./stage-images.ts";

/**
 * Production keeps its fleet applications on destroy (`retain()`), so a rehearsal stage's destroy
 * drops only their State rows. Its own applications, found by name, are deleted here.
 */
export async function stageApplications(
  mode: "delete" | "verify",
  input: { accountId: string; token: string; stage: string },
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  const api = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/containers/applications`;
  const headers = { Authorization: `Bearer ${input.token}` };
  const listed = await fetcher(api, { headers });
  const body = (await listed.json()) as { success?: boolean; result?: { id?: string; name?: string }[] };
  if (!listed.ok || body.success !== true || !Array.isArray(body.result))
    throw new Error(`Container application list failed with HTTP ${listed.status}`);
  const owned = body.result.filter((app) => typeof app.name === "string" && typeof app.id === "string" && ownedByStage(app.name, input.stage));
  if (mode === "verify") {
    if (owned.length) throw new Error("Rehearsal container applications remain");
    return [];
  }
  for (const app of owned) {
    const removed = await fetcher(`${api}/${encodeURIComponent(app.id!)}`, { method: "DELETE", headers });
    if (!removed.ok && removed.status !== 404) throw new Error(`Container application delete failed with HTTP ${removed.status}`);
  }
  return owned.map((app) => app.name!);
}
