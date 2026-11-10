import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";

export const token = `art_v1_${"a".repeat(40)}?expires=4102444800`;
export function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  });
}
export const pkt = (bytes: Uint8Array | string) => {
  const body = Buffer.from(bytes);
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]);
};
export function stripCapabilities(body: Buffer, omitted: readonly string[]) {
  const parts: Buffer[] = [];
  for (let at = 0; at < body.length;) {
    const size = Number.parseInt(body.toString("utf8", at, at + 4), 16);
    if (!size) {
      parts.push(body.subarray(at, at + 4));
      at += 4;
      continue;
    }
    const data = body.subarray(at + 4, at + size),
      nul = data.indexOf(0);
    parts.push(
      nul < 0
        ? pkt(data)
        : pkt(
            Buffer.concat([
              data.subarray(0, nul + 1),
              Buffer.from(
                data
                  .subarray(nul + 1)
                  .toString()
                  .trimEnd()
                  .split(" ")
                  .filter((cap) => !omitted.includes(cap))
                  .join(" ") + "\n",
              ),
            ]),
          ),
    );
    at += size;
  }
  return Buffer.concat(parts);
}
export function responsePack(body: Buffer) {
  const chunks: Buffer[] = [];
  for (let at = 0; at < body.length;) {
    if (body.toString("utf8", at, at + 4) === "PACK") {
      chunks.push(body.subarray(at));
      break;
    }
    const length = Number.parseInt(body.toString("utf8", at, at + 4), 16);
    if (!length) {
      at += 4;
      continue;
    }
    const data = body.subarray(at + 4, at + length);
    if (data[0] === 1) chunks.push(data.subarray(1));
    at += length;
  }
  return Buffer.concat(chunks);
}

export async function backend() {
  const root = mkdtempSync(join(tmpdir(), "git-transport-")),
    bare = join(root, "repo.git");
  git(root, "init", "--bare", "--initial-branch=main", bare);
  git(bare, "config", "http.receivepack", "true");
  const control = {
    requests: 0,
    pushes: 0,
    omitted: [] as string[],
    status: 0,
    uploadRequests: [] as Buffer[],
    uploadReplies: [] as Buffer[],
    pushBodies: [] as Buffer[],
    transform: null as null | ((path: string, body: Buffer) => Buffer),
  };
  const children = new Set<ReturnType<typeof spawn>>();
  const server = createServer(async (request, response) => {
    control.requests++;
    const password = Buffer.from(
      (request.headers.authorization ?? "").replace(/^Basic /, ""),
      "base64",
    )
      .toString()
      .split(":")
      .slice(1)
      .join(":");
    if (password !== token.split("?")[0]) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
      response.end();
      return;
    }
    if (control.status) {
      response.writeHead(control.status, control.status === 307 ? { Location: "/redirect" } : {});
      response.end();
      return;
    }
    const address = new URL(request.url!, "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    if (address.pathname.endsWith("git-receive-pack")) {
      control.pushes++;
      control.pushBodies.push(body);
    }
    if (address.pathname.endsWith("git-upload-pack")) control.uploadRequests.push(body);
    const child = spawn("git", ["http-backend"], {
      env: {
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "test",
        REQUEST_METHOD: request.method!,
        PATH_INFO: address.pathname,
        QUERY_STRING: address.search.slice(1),
        CONTENT_LENGTH: String(body.length),
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        SERVER_PROTOCOL: "HTTP/1.1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.resume();
    child.on("error", () => {
      response.writeHead(500);
      response.end();
    });
    child.on("close", () => {
      children.delete(child);
      const raw = Buffer.concat(output),
        split = raw.indexOf("\r\n\r\n");
      if (split < 0) {
        if (!response.headersSent) response.writeHead(500);
        response.end();
        return;
      }
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of raw.subarray(0, split).toString().split("\r\n")) {
        const colon = line.indexOf(":"),
          name = line.slice(0, colon),
          value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
        else headers[name] = value;
      }
      let data: Buffer = raw.subarray(split + 4);
      if (address.pathname.endsWith("info/refs")) data = stripCapabilities(data, control.omitted);
      if (control.transform) data = control.transform(address.pathname, data);
      if (address.pathname.endsWith("git-upload-pack")) control.uploadReplies.push(data);
      response.writeHead(status, headers);
      response.end(data);
    });
    child.stdin.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    root,
    bare,
    control,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/repo.git`,
    async close() {
      for (const child of children) child.kill();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
