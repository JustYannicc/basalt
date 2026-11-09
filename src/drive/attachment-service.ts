import { openAttachmentStore, sha256, type AttachmentBucket } from "./shared/index.ts";
import type { meteredBucket } from "./io-quota.ts";

export function vaultAttachments(input: {
  bucket: AttachmentBucket;
  prefix: string;
  now: () => number;
  uploads: ReturnType<typeof meteredBucket>["uploads"];
}) {
  const store = openAttachmentStore(input);
  const prefix = (id: string) => `${input.prefix}attachments/uploads/${id}/`;
  return {
    ...store,
    async begin(value: Parameters<typeof store.begin>[0]) {
      const id = sha256(new TextEncoder().encode(value.operation));
      if (!(await store.head({ oid: value.oid })))
        input.uploads.reserve({
          prefix: prefix(id),
          manifest: `${input.prefix}attachments/objects/${value.oid}.json`,
          fingerprint: `${value.oid}:${value.bytes}`,
          bytes: value.bytes + 4096 + Math.ceil(value.bytes / (1024 * 1024)) * 96,
        });
      return store.begin(value);
    },
    async complete(value: Parameters<typeof store.complete>[0]) {
      const result = await store.complete(value);
      if (result.state === "present") input.uploads.close(prefix(value.upload));
      return result;
    },
    async cancel(value: Parameters<typeof store.cancel>[0]) {
      const result = await store.cancel(value);
      if (result.next === null) input.uploads.close(prefix(value.upload));
      return result;
    },
  };
}
