import { readFile, writeFile } from "node:fs/promises";
import { requireSuccessfulCatalogAcceptance } from "./catalog-acceptance-receipt.ts";
import type { CatalogAcceptanceResult } from "./catalog-acceptance.ts";

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === [...keys].sort().join("\n")
  );
}

/** A skipped client or a successful command without the public evidence cannot turn this green. */
export function requireSuccessfulSmoke(value: unknown): void {
  if (
    !exactKeys(value, ["version", "mode", "signIn", "pool", "clients", "cleanup"]) ||
    value.version !== 1 ||
    value.mode !== "preview" ||
    value.signIn !== true ||
    value.pool !== true ||
    value.cleanup !== true ||
    !Array.isArray(value.clients) ||
    value.clients.length !== 2
  ) {
    throw new Error("The live preview smoke result is missing or incomplete");
  }
  for (const [index, client] of ["claude", "codex"].entries()) {
    const result: unknown = value.clients[index];
    if (
      !exactKeys(result, [
        "client",
        "exit",
        "timeout",
        "modelRequest",
        "toolSearch",
        "undo",
        "revoke",
      ]) ||
      result.client !== client ||
      result.exit !== 0 ||
      result.timeout !== false ||
      result.modelRequest !== true ||
      result.toolSearch !== true ||
      result.undo !== true ||
      result.revoke !== true
    ) {
      throw new Error("Both native clients must pass model, tool, undo and revocation checks");
    }
  }
}

export type PreviewReceipt = {
  pullRequest: number;
  head: string;
  base: string;
  smoke: true;
  teardown: true;
} & ({ version: 1 } | { version: 2; catalogAcceptance: CatalogAcceptanceResult });

export function previewReceipt(
  result: unknown,
  identity: { pullRequest: number; head: string; base: string; compilerAcceptance?: true },
  teardownVerified: boolean,
  catalogAcceptance?: unknown,
): PreviewReceipt {
  requireSuccessfulSmoke(result);
  if (
    !Number.isSafeInteger(identity.pullRequest) ||
    identity.pullRequest < 1 ||
    !/^[a-f0-9]{40}$/.test(identity.head) ||
    !/^[a-f0-9]{40}$/.test(identity.base)
  ) {
    throw new Error("A preview receipt requires an exact PR, head and base");
  }
  if (!teardownVerified) throw new Error("Preview resource teardown has not been verified");
  const candidate = { pullRequest: identity.pullRequest, head: identity.head, base: identity.base };
  if (identity.compilerAcceptance) {
    requireSuccessfulCatalogAcceptance(catalogAcceptance, identity.head);
    return { version: 2, ...candidate, smoke: true, teardown: true, catalogAcceptance };
  }
  if (catalogAcceptance !== undefined)
    throw new Error("An ordinary preview cannot claim compiler acceptance");
  return { version: 1, ...candidate, smoke: true, teardown: true };
}

export async function writePreviewReceipt(
  resultPath: string,
  receiptPath: string,
  identity: { pullRequest: number; head: string; base: string },
  teardownVerified: boolean,
): Promise<void> {
  const result: unknown = JSON.parse(await readFile(resultPath, "utf8"));
  const receipt = previewReceipt(result, identity, teardownVerified);
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
}
