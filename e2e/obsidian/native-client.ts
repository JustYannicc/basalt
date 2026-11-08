import assert from "node:assert/strict";
import { createRemote } from "../../clients/obsidian/remote.ts";
import { encodeAttachmentPointer, sha256 } from "../../src/drive/shared/index.ts";
import { object } from "../../clients/obsidian/http.ts";

/** Actual installed framework and MCP transport; identity is synthetic, not hosted OAuth. */
export async function verifyNativeClient(
  origin: string,
  appSlug: string,
  appId: string,
  rename: () => Promise<void>,
) {
  const bytes = Uint8Array.from({ length: 17 * 1048576 + 13 }, (_, i) => (i * 17 + 5) % 251),
    oid = sha256(bytes);
  let lose = true,
    partBodies = 0;
  const remote = createRemote({
    appSlug,
    appId,
    allowLoopback: true,
    saveSession: async () => {},
    session: {
      resource: origin + "/mcp?connection=synthetic&elicitation_mode=native",
      clientId: "synthetic",
      tokenEndpoint: origin + "/unused",
      revocationEndpoint: null,
      accessToken: "synthetic-local-fixture",
      refreshToken: "",
      expiresAt: Date.now() + 3600000,
    },
    http: async (url, init) => {
      const response = await fetch(url, { ...init, redirect: "error" }),
        body = await response.text();
      if (init.body) {
        const rpc = object(JSON.parse(init.body));
        if (rpc.method === "tools/call") {
          const call = object(object(object(rpc.params).arguments).calls);
          if (call.path === "importRequest") {
            const request = object(object(call.input).request);
            if (request.method === "uploadAttachmentPart") {
              partBodies++;
              if (lose) {
                lose = false;
                throw new Error("Synthetic accepted part reply lost");
              }
            }
          }
        }
      }
      return { status: response.status, headers: Object.fromEntries(response.headers), body };
    },
  });
  try {
    await remote.list();
    await rename();
    assert.ok((await remote.list()).at);
    assert.ok(remote.initial);
    const id = "native-plugin-import";
    await remote.initial.plan({
      id,
      page: 0,
      entries: [{ path: "large.pdf", kind: "attachment", bytes: bytes.length, hash: oid }],
      final: true,
    });
    remote.initial.activate(id);
    const base = (await remote.list()).at;
    const start = await remote.beginAttachment({
      operation: "native-upload",
      oid,
      bytes: bytes.length,
    });
    assert.equal(start.state, "uploading");
    const send = (upload: string, part: number) =>
      remote.uploadAttachmentPart({
        upload,
        part,
        contentBase64: Buffer.from(
          bytes.subarray(part * 1048576, Math.min(bytes.length, (part + 1) * 1048576)),
        ).toString("base64"),
      });
    await assert.rejects(send(start.upload, 0), /reply lost/);
    const resumed = await remote.beginAttachment({
      operation: "native-upload",
      oid,
      bytes: bytes.length,
    });
    assert.equal(resumed.missing.includes(0), false);
    for (const part of resumed.missing) await send(resumed.upload, part);
    let cursor: number | null = 0;
    do {
      const page = await remote.completeAttachment({
        upload: resumed.upload,
        ...(cursor ? { cursor } : {}),
      });
      cursor = page.next;
    } while (cursor !== null);
    const receipt = await remote.apply({
      base,
      operation: "native-attach",
      edits: [
        {
          path: "large.pdf",
          content: new TextDecoder().decode(encodeAttachmentPointer({ oid, bytes: bytes.length })),
        },
      ],
    });
    assert.equal(receipt.state, "landed");
    assert.equal((await remote.receipt("native-attach"))?.oid, receipt.oid);
    const tail = await remote.download({
      path: "large.pdf",
      at: receipt.oid,
      offset: 17 * 1048576,
      maxBytes: 13,
    });
    assert.deepEqual(
      Buffer.from(tail!.contentBase64, "base64"),
      Buffer.from(bytes.subarray(17 * 1048576)),
    );
    const complete = await remote.initial.finish(id);
    assert.equal(complete.confirmed, 1);
    assert.equal(complete.state, "complete");
    assert.equal(partBodies, 18);
    return {
      bytes: bytes.length,
      parts: partBodies,
      acceptedPartReplays: 0,
      importCostMicros: complete.usedCostMicros,
    };
  } finally {
    await remote.close();
  }
}
