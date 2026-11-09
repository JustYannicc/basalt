import { object, text, number } from "./http.ts";
import type { ImportStatus, InitialRemote } from "./import-types.ts";
const integer = (data: Record<string, unknown>, key: string) => {
  const value = number(data, key);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid initial import usage");
  return value;
};
const usage = (raw: unknown) => {
  const data = object(raw);
  return {
    classA: integer(data, "classA"),
    classB: integer(data, "classB"),
    readBytes: integer(data, "readBytes"),
  };
};
export function decodeImportStatus(raw: unknown): ImportStatus {
  const data = object(raw);
  if (data.state !== "planning" && data.state !== "ready" && data.state !== "complete")
    throw new Error("Invalid initial import state");
  return {
    id: text(data, "id"),
    state: data.state,
    nextPage: integer(data, "nextPage"),
    files: integer(data, "files"),
    bytes: integer(data, "bytes"),
    confirmed: integer(data, "confirmed"),
    omitted: integer(data, "omitted"),
    manifest: typeof data.manifest === "string" ? data.manifest : "",
    reserved: usage(data.reserved),
    used: usage(data.used),
    reservedCostMicros: integer(data, "reservedCostMicros"),
    usedCostMicros: integer(data, "usedCostMicros"),
    expiresAt: integer(data, "expiresAt"),
  };
}
const methods = new Map([
  ["listNotes", "list"],
  ["readNote", "read"],
  ["applyNotes", "apply"],
  ["operationStatus", "receipt"],
  ["changes", "changes"],
  ["fileInfo", "info"],
  ["readAttachment", "attachment"],
  ["beginAttachment", "beginAttachment"],
  ["uploadAttachmentPart", "uploadAttachmentPart"],
  ["completeAttachment", "completeAttachment"],
  ["cancelAttachment", "cancelAttachment"],
]);
export function initialTransport(raw: (name: string, input: unknown) => Promise<unknown>) {
  let id: string | null = null;
  const initial: InitialRemote = {
    current: async () => {
      const value = await raw("importStatus", {});
      return value === null ? null : decodeImportStatus(value);
    },
    plan: async (input) => decodeImportStatus(await raw("planImport", input)),
    finish: async (id) => decodeImportStatus(await raw("finishImport", { id })),
    activate: (value) => {
      id = value;
    },
  };
  return {
    initial,
    call: (name: string, input: unknown) => {
      const method = methods.get(name);
      return id && method
        ? raw("importRequest", { id, request: { operation: "drive", method, input } })
        : raw(name, input);
    },
  };
}
