import { encodeAttachmentPointer } from "../../src/drive/shared/bytes.ts";
import { maximumFileBytes, type Edit, type RemoteVault } from "./types.ts";
import type { RemoteBinary } from "./binary-types.ts";
import type { ConflictChoice } from "./attachments.ts";
export function binaryConflictTools(
  remote: RemoteVault & RemoteBinary,
  resolve: ((ref: string, edits: readonly Edit[]) => Promise<void>) | undefined,
) {
  return {
    async describeVersion(path: string, at: string) {
      const file = await remote.info({ path, at });
      return file
        ? { bytes: file.bytes, mime: null, blob: file.blob, external: file.attachment !== null }
        : null;
    },
    async resolveMixed(ref: string, choices: readonly ConflictChoice[]) {
      if (!resolve) throw new Error("Resume sync before resolving this conflict");
      const edits: Edit[] = [];
      for (const choice of choices) {
        if (choice.kind === "text") {
          edits.push({ path: choice.path, content: choice.content });
          continue;
        }
        const info = await remote.info({ path: choice.path, at: choice.at });
        if (!info) {
          edits.push({ path: choice.path, content: null });
          continue;
        }
        if (info.attachment) {
          edits.push({
            path: choice.path,
            content: new TextDecoder().decode(encodeAttachmentPointer(info.attachment)),
          });
          continue;
        }
        let content = "",
          offset = 0;
        for (;;) {
          const page = await remote.read({
            path: choice.path,
            at: choice.at,
            offset,
            maxBytes: 65536,
          });
          if (!page || page.bytes > maximumFileBytes)
            throw new Error("The selected version cannot be read on this device");
          content += page.content;
          if (page.next === null) break;
          if (page.next <= offset) throw new Error("Selected version download did not advance");
          offset = page.next;
        }
        edits.push({ path: choice.path, content });
      }
      await resolve(ref, edits);
    },
  };
}
