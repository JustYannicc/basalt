import { PoolHome, type HomeClient } from "../control.ts";
import { text } from "../json.ts";
import type { ImportAccountTarget } from "./import-account-mapping.ts";

/** Only current pool members can receive an operator's historical account binding. */
export async function importAccountTargets(
  client: HomeClient,
  pool: string,
): Promise<ImportAccountTarget[]> {
  const home = new PoolHome(client, pool);
  const [membership, files] = await Promise.all([home.membership(), home.credentials()]);
  const members = new Set(membership.members.map((member) => member.auth_id));
  return files.flatMap((file) => {
    const id = text(file.id),
      provider = text(file.provider) ?? text(file.type);
    return id && provider && members.has(id) && file.disabled !== true ? [{ id, provider }] : [];
  });
}
