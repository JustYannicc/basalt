import { Effect, Schema } from "effect";
import { DriveRequestFailed, type DriveCommand, type DriveHost } from "apps/contracts";
import {
  DriveError,
  type openAttachmentStore,
  type createChangeReader,
  type Drive,
} from "./shared/index.ts";
import { createDriveService } from "./service.ts";
import { QuotaExceeded } from "./quota-limits.ts";
import type { importService } from "./import-service.ts";
import type { noteHistory } from "./note-history.ts";

/** One host-bound service handles only decoded commands for its own app. */
export function createDriveDispatcher(
  drive: Drive,
  attachments?: ReturnType<typeof openAttachmentStore>,
  changes?: ReturnType<typeof createChangeReader>,
  importBase?: string,
  imports?: ReturnType<typeof importService>,
  /** A vault's own history and device record; a drive without a clone has neither. */
  notes?: ReturnType<typeof noteHistory> & { devices(): Promise<unknown> },
): DriveHost {
  const service = createDriveService(drive, attachments, changes, importBase);
  const run = async (command: DriveCommand) => {
    const uploads = () => {
      if (!attachments) throw new DriveError("invalid", "Attachment storage is not configured");
      return attachments;
    };
    switch (command.method) {
      case "planImport":
      case "importStatus":
      case "runImport":
      case "finishImport": {
        if (!imports) throw new DriveError("invalid", "Initial import service is not configured");
        if (command.method === "planImport") return imports.plan(command.input);
        if (command.method === "importStatus") return imports.status(command.input.id);
        if (command.method === "runImport") return imports.run(command.input);
        return imports.finish(command.input.id);
      }
      case "changes":
        return service.changes(command.input);
      case "info":
        return service.info(command.input);
      case "attach":
        return service.attach(command.input);
      case "beginAttachment":
        return uploads().begin(command.input);
      case "completeAttachment":
        return uploads().complete(command.input);
      case "cancelAttachment":
        return uploads().cancel(command.input);
      case "uploadAttachmentPart": {
        const raw = atob(command.input.contentBase64);
        if (btoa(raw) !== command.input.contentBase64 || raw.length > 1048576)
          throw new DriveError("invalid", "Invalid attachment part encoding");
        const content = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) content[i] = raw.charCodeAt(i);
        return uploads().put({ ...command.input, content });
      }
      case "apply":
        return service.apply(command.input);
      case "attachment":
        return service.attachment(command.input);
      case "receipt":
        return service.receipt(command.input);
      case "resolve":
        return service.resolve(command.input);
      case "list":
        return service.list(command.input);
      case "read":
        return service.read(command.input);
      case "search":
        return service.search(command.input);
      case "history":
        // The note history adds commit times and a path filter; it serves a vault with a clone.
        if (notes) return notes.history(command.input);
        if (command.input.path !== undefined)
          throw new DriveError("invalid", "This drive has no per-note history");
        return service.history(command.input);
      case "devices":
        if (!notes) throw new DriveError("invalid", "This drive records no devices");
        return notes.devices();
      case "write":
        return service.write(command.input);
      case "move":
        return service.move(command.input);
      case "remove":
        return service.remove(command.input);
      case "restore":
        return service.restore(command.input);
    }
  };
  return (command) =>
    Effect.tryPromise({
      try: () => run(command),
      catch: (error) =>
        new DriveRequestFailed({
          ...(error instanceof QuotaExceeded
            ? {
                message: error.message,
                resource: error.resource,
                used: error.used,
                limit: error.limit,
                ...(error.resetAt === null ? {} : { resetAt: error.resetAt }),
              }
            : {}),
          reason:
            error instanceof DriveError
              ? error.code === "invalid"
                ? "invalid_request"
                : error.code
              : "outcome_unknown",
        }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
      Effect.catchTag("SchemaError", () => new DriveRequestFailed({ reason: "invalid_response" })),
    );
}
