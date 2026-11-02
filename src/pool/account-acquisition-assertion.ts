import { object, readBody, text } from "./json.ts";
import { openEnvelope } from "./token.ts";
import { accountAcquisitionPrefix } from "./account-acquisition-contract.ts";

/** The host signs only after authorizing the saved account and resolving its binding. */
export async function acquisitionAssertion(
  request: Request,
  key: string,
  previousKey?: string,
  now = Date.now(),
) {
  const bytes = await readBody(request, 32_768);
  if (bytes === undefined) throw new Error("Invalid account assertion");
  const body: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
  );
  const value =
    object(body) && typeof body.envelope === "string"
      ? await openEnvelope(key, accountAcquisitionPrefix, body.envelope, previousKey)
      : undefined;
  if (
    !object(value) ||
    !text(value.owner) ||
    typeof value.operation !== "string" ||
    !value.operation ||
    typeof value.at !== "number" ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.at) ||
    !Number.isFinite(value.expiresAt) ||
    value.at > now + 5_000 ||
    value.expiresAt <= now ||
    value.expiresAt <= value.at ||
    value.expiresAt - value.at > 30_000 ||
    value.operation.length > 255
  )
    throw new Error("Invalid account assertion");
  return value;
}
