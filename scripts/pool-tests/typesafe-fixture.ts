import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { SyntheticOAuthProvider } from "./import-fixture.ts";

export class TypeSafeFixture {
  readonly calls: { key: string; body: unknown; encoding: string; multipart: boolean; images: number; danger: string | undefined }[] = [];
  failure = 0;
  disconnect = false;
  readonly provider = new SyntheticOAuthProvider((request, response, raw) => this.respond(request, response, raw));
  private async respond(request: IncomingMessage, response: ServerResponse, raw: Buffer): Promise<boolean> {
    if (request.headers.host !== "api.typesafe.ai") return false;
    const key = request.headers.authorization ?? "";
    assert.ok(key === "Bearer synthetic-typesafe-a" || key === "Bearer synthetic-typesafe-b");
    if (request.url === "/v1/models") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ models: [
        { name: "jev-shared", description: "Shared fixture model", release_date: "2026-09-15" },
        { name: key.endsWith("-a") ? "jev-a" : "jev-b", description: "Account-bound fixture model", release_date: "2026-10-01" },
      ] }));
      return true;
    }
    assert.equal(request.url, "/v1/systemone");
    const encoding = request.headers["content-encoding"] ?? "";
    const decoded = encoding === "zstd" ? zstdDecompressSync(raw) : encoding === "gzip" ? gunzipSync(raw) : raw;
    const multipart = String(request.headers["content-type"]).startsWith("multipart/");
    let body: unknown;
    let images = 0;
    if (multipart) {
      const parts = await new Response(new Uint8Array(decoded), { headers: { "Content-Type": String(request.headers["content-type"]) } }).formData();
      body = JSON.parse(String(parts.get("request")));
      images = [...parts.values()].filter((part) => part instanceof File).length;
    } else body = JSON.parse(decoded.toString());
    this.calls.push({ key, body, encoding, multipart, images, danger: request.headers["typesafe-danger-zone-images"] as string | undefined });
    if (this.disconnect) { request.socket.destroy(); return true; }
    if (this.failure) {
      response.writeHead(this.failure, { "Content-Type": "application/json", "Retry-After": "7", "X-Request-Id": "fixture-native-error" });
      response.end(JSON.stringify({ detail: `native-typesafe-${this.failure}` }));
      return true;
    }
    const envelope = body as { model: string; questions: Record<string, unknown> };
    const answers = Object.fromEntries(Object.keys(envelope.questions).map((name) => [name, { type: "noul", noul: 0.75 }]));
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      model: envelope.model, answers, usage: { input_tokens: 17, output_tokens: 3 },
    }));
    return true;
  }
}
