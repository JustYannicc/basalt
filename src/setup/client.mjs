import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { brand } from "../../brand.ts";
import { configure } from "./files.mjs";

const args = process.argv.slice(2);
const undo = args.length === 1 && args[0] === "--undo";
function endpoint(raw) {
  const url = new URL(raw);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
    || url.username || url.password) throw new Error("Use the HTTPS setup link from your pool.");
  return url;
}
async function payload() {
  if (args.length !== 2 || !["--link", "--payload-file"].includes(args[0]))
    throw new Error("Use --link <one-time setup URL>, --payload-file <private JSON file>, or --undo.");
  if (args[0] === "--payload-file") return JSON.parse(await readFile(args[1], "utf8"));
  const link = endpoint(args[1]);
  if (link.origin !== `https://${brand.host}` || !/^\/setup\/claim\/[a-f0-9]{64}$/.test(link.pathname)) throw new Error("Use the setup link from your pool.");
  const response = await fetch(`https://${brand.host}/${link.pathname.slice(1)}`, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("The setup link is expired, already used, or unavailable. Open setup again from your pool.");
  if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("The setup link did not return setup instructions.");
  const body = await response.text();
  if (body.length > 64_000) throw new Error("The setup instructions are too large.");
  return JSON.parse(body);
}
try {
  const data = undo ? null : await payload();
  if (data) {
    if (data.version !== 1 || data.brand?.setup?.id !== brand.setup.id) throw new Error("These setup instructions are not supported.");
    const credentials = data.credentials;
    for (const name of ["modelKey", "toolsToken"])
      if (typeof credentials?.[name] !== "string" || !credentials[name] || /\s/.test(credentials[name])) throw new Error("Setup credentials are invalid.");
    endpoint(credentials.modelUrl);
    endpoint(credentials.toolsUrl);
    if (new URL(credentials.modelUrl).pathname !== "/" || credentials.modelUrl.endsWith("/")) throw new Error("The model gateway must be an origin without a trailing slash.");
  }
  await configure({ home: homedir(), env: process.env, brand: data?.brand ?? brand, credentials: data?.credentials, undo });
  process.stdout.write(undo
    ? `${brand.name} setup removed. Backups restored; later unrelated edits kept. Restart your apps. To stop access, revoke the computer in your pool.\n`
    : `${data.brand.name} setup is done. Restart Claude Code or Codex, send a message, and ask for a tool search through ${data.brand.mcpServerName}. Sign Codex into any ChatGPT account; account-side features follow its plan. The Claude desktop app is not covered.\n`);
} catch {
  // Parser and filesystem errors can quote source lines containing a credential.
  process.stderr.write(`${brand.name} setup could not finish. Check the link, Node.js 18+, config syntax and file permissions. Existing backups are kept. Run --undo to recover an interrupted setup.\n`);
  process.exitCode = 1;
}
