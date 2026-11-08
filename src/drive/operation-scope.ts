import type { Drive } from "./shared/index.ts";
import type { createDriveService } from "./service.ts";
import type { vaultAttachments } from "./attachment-service.ts";
import type { meteredBucket } from "./io-quota.ts";

/** Every public operation enters the same queue, so an import meter cannot leak to another caller. */
export function operationScope(
  drive: Drive,
  service: ReturnType<typeof createDriveService>,
  attachments: ReturnType<typeof vaultAttachments>,
  run: ReturnType<typeof meteredBucket>["run"],
) {
  const protect =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    (...args: A) =>
      run(() => call(...args));
  return {
    drive: {
      initialize: protect(drive.initialize),
      openWriter: protect(drive.openWriter),
      commit: protect(drive.commit),
      land: protect(drive.land),
      resolve: protect(drive.resolve),
      list: protect(drive.list),
      read: protect(drive.read),
      history: protect(drive.history),
      receipt: protect(drive.receipt),
    },
    service: {
      list: protect(service.list),
      read: protect(service.read),
      info: protect(service.info),
      bytes: protect(service.bytes),
      attachment: protect(service.attachment),
      changes: protect(service.changes),
      search: protect(service.search),
      receipt: protect(service.receipt),
      apply: protect(service.apply),
      resolve: protect(service.resolve),
      history: protect(service.history),
      write: protect(service.write),
      move: protect(service.move),
      remove: protect(service.remove),
      restore: protect(service.restore),
      attach: protect(service.attach),
    },
    attachments: {
      begin: protect(attachments.begin),
      status: protect(attachments.status),
      put: protect(attachments.put),
      complete: protect(attachments.complete),
      cancel: protect(attachments.cancel),
      head: protect(attachments.head),
      read: protect(attachments.read),
    },
    protect,
  };
}
