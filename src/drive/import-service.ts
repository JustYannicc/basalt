import { Schema, Option } from "effect";
import { DriveCommand, type DriveImportPlan } from "apps/contracts";
import { DriveError, decodeAttachmentPointer, sha256 } from "./shared/index.ts";
import type { importManifest } from "./import-manifest.ts";
import type { createDriveService } from "./service.ts";
import type { vaultAttachments } from "./attachment-service.ts";
import type { meteredBucket } from "./io-quota.ts";

export function importService(input: {
  manifest: ReturnType<typeof importManifest>;
  service: ReturnType<typeof createDriveService>;
  attachments: ReturnType<typeof vaultAttachments>;
  run: ReturnType<typeof meteredBucket>["run"];
}) {
  const { manifest, service, attachments, run } = input;
  const execute = async (id: string, request: unknown) => {
    manifest.ready(id);
    const decoded = Schema.decodeUnknownOption(DriveCommand)(request, {
      onExcessProperty: "error",
    });
    if (Option.isNone(decoded)) throw new DriveError("invalid", "Invalid initial import request");
    const command = decoded.value;
    switch (command.method) {
      case "apply": {
        const entries = await Promise.all(
          command.input.edits.map(async (edit) => {
            if (edit.content === null)
              throw new DriveError("invalid", "Initial import cannot remove a manifest file");
            const content = new TextEncoder().encode(edit.content),
              pointer = decodeAttachmentPointer(content);
            if (pointer)
              return {
                path: edit.path,
                kind: "attachment" as const,
                bytes: pointer.bytes,
                hash: pointer.oid,
              };
            if (content.length === 0 && !edit.path.endsWith(".md"))
              return {
                path: edit.path,
                kind: "attachment" as const,
                bytes: 0,
                hash: sha256(content),
              };
            const header = new TextEncoder().encode(`blob ${content.length}\0`),
              bytes = new Uint8Array(header.length + content.length);
            bytes.set(header);
            bytes.set(content, header.length);
            const digest = await crypto.subtle.digest("SHA-1", bytes);
            return {
              path: edit.path,
              kind: "note" as const,
              bytes: content.length,
              hash: [...new Uint8Array(digest)]
                .map((x) => x.toString(16).padStart(2, "0"))
                .join(""),
            };
          }),
        );
        manifest.claim(id, command.input.operation, entries);
        const result = await service.apply(command.input);
        if (result.state === "landed" || result.state === "conflict")
          manifest.confirm(command.input.operation);
        return result;
      }
      case "receipt": {
        manifest.operation(id, command.input.operation);
        const receipt = await service.receipt(command.input);
        if (receipt?.state === "landed" || receipt?.state === "conflict")
          manifest.confirm(command.input.operation);
        return receipt;
      }
      case "beginAttachment":
        manifest.beginUpload(id, command.input.operation, command.input.oid, command.input.bytes);
        return attachments.begin(command.input);
      case "uploadAttachmentPart": {
        manifest.upload(id, command.input.upload);
        const raw = atob(command.input.contentBase64);
        if (btoa(raw) !== command.input.contentBase64 || raw.length > 1048576)
          throw new DriveError("invalid", "Invalid attachment part encoding");
        return attachments.put({
          ...command.input,
          content: Uint8Array.from(raw, (x) => x.charCodeAt(0)),
        });
      }
      case "completeAttachment":
        manifest.upload(id, command.input.upload);
        return attachments.complete(command.input);
      case "cancelAttachment":
        manifest.upload(id, command.input.upload);
        return attachments.cancel(command.input);
      case "list":
        return service.list(command.input);
      case "read":
        return service.read(command.input);
      case "info":
        return service.info(command.input);
      case "attachment":
        return service.attachment(command.input);
      case "changes":
        return service.changes(command.input);
      default:
        throw new DriveError("invalid", `${command.method} is not an initial-import operation`);
    }
  };
  return {
    plan: (page: typeof DriveImportPlan.Type) => run(async () => manifest.plan(page)),
    status: async (id?: string) => (id === undefined ? manifest.current() : manifest.status(id)),
    run: (value: { id: string; request: unknown }) => {
      const id = value.id,
        request = structuredClone(value.request);
      return run(() => execute(id, request), id);
    },
    finish: (id: string) => run(async () => manifest.finish(id)),
  };
}
