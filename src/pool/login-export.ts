import type { HomeClient, PoolHome } from "./control.ts";
import { BackendFailure, fail, object, unavailable } from "./json.ts";

const maxFileBytes = 1024 * 1024;

async function requireMembership(home: PoolHome, id: string): Promise<void> {
  // Refresh groups too: a cached group id may have been renamed outside this controller.
  const membership = home.ownMembership(await home.allMembership());
  if (!membership.members.some((member) => member.auth_id === id)) {
    fail(404, "not_found", "This account is not in this pool.");
  }
}

async function readFile(response: Response, provider: string): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) return unavailable();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxFileBytes) return unavailable();
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!object(value) || value.type !== provider) return unavailable();
    return bytes;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Called only after control token and owner authorization. Never returns Home error bodies. */
export async function exportLoginFile(url: URL, client: HomeClient, home: PoolHome,
  contributors: () => Promise<Record<string, string>>): Promise<Response> {
  let id: string;
  try { id = decodeURIComponent(url.pathname.split("/").at(-2)!); }
  catch { return fail(400, "invalid_query", "Provide a valid account id."); }
  const provider = url.searchParams.get("provider");
  if (!id || id.length > 256 || /[\p{Cc}\p{White_Space}/\\]/u.test(id)
    || (provider !== "claude" && provider !== "codex")
    || url.searchParams.getAll("provider").length !== 1
    || [...url.searchParams.keys()].some((key) => key !== "provider")) {
    return fail(400, "invalid_query", "Provide an account id and exactly one provider: claude or codex.");
  }
  const addedBy = (await contributors())[id];
  if (addedBy !== undefined && addedBy !== home.owner) {
    return fail(403, "not_owner", "Only accounts added by the pool owner can be exported.");
  }
  await requireMembership(home, id);
  const files = (await home.credentials()).filter((row) => row.id === id);
  if (!files.length) return fail(404, "not_found", "This account no longer exists.");
  if (files.length !== 1) return unavailable();
  const file = files[0]!;
  if (file.provider !== provider || file.type !== provider) {
    return fail(404, "not_found", "This account does not match the requested provider.");
  }
  const response = await client.response(`/credentials/download?${new URLSearchParams({ id })}`, { redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 404) return fail(404, "not_found", "This account no longer exists.");
    throw new BackendFailure(response.status);
  }
  const bytes = await readFile(response, provider);
  // Do not release a secret if membership disappeared while Home was downloading it.
  await requireMembership(home, id);
  return new Response(bytes, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
