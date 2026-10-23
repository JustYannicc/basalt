import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateInventory, type NativeInventory, type WorkerMetadata } from "./native-stack-fixtures.ts";

export interface StackResource { id: string; kind: string; source: string }
export interface StackInventoryRecord extends StackResource { declaredName: string; ownerId?: string }

export function resourceId(type: string, fqn: string): string {
  return `resource-${createHash("sha256").update(`${type}\0${fqn}`, "utf8").digest("hex")}`;
}

function executable(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const path = resolve(directory, name);
    try { accessSync(path, constants.X_OK); return realpathSync(path); } catch { /* Try the next PATH entry. */ }
  }
  throw new Error(`Native stack inventory requires ${name}`);
}

function evaluate(root: string): NativeInventory {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "native-stack-")));
  try {
    const bun = executable("bun");
    for (const name of ["auth", "tmp", "cache"]) mkdirSync(join(scratch, name));
    // HOME is never reassigned. Alchemy's supported auth override is isolated instead.
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin", CI: "true", DO_NOT_TRACK: "1",
      ALCHEMY_HOME: join(scratch, "auth"), TMPDIR: join(scratch, "tmp"),
      BUN_INSTALL_CACHE_DIR: join(scratch, "cache"), NATIVE_STACK_ROOT: realpathSync(root),
    };
    const worker = fileURLToPath(new URL("./native-stack-worker.mjs", import.meta.url));
    let command: string, args: string[];
    if (process.platform === "darwin") {
      command = "/usr/bin/sandbox-exec";
      // JSON string quoting is also valid for sandbox profile string literals.
      const quote = JSON.stringify;
      const denied = [".alchemy", ".aws", ".config", ".ssh", "Library/Keychains"].map(name =>
        `(subpath ${quote(join(homedir(), name))})`).join(" ");
      const profile = join(scratch, "sandbox.sb");
      writeFileSync(profile, `(version 1)\n(allow default)\n(deny network*)\n(deny file-write*)\n` +
        `(allow file-write* (subpath ${quote(scratch)}) (literal "/dev/null"))\n(deny file-read* ${denied})\n`);
      args = ["-f", profile, bun, "run", worker];
    } else if (process.platform === "linux") {
      command = executable("sudo");
      // CI permits sudo -n. Drop privileges before evaluating declarations. No fallback
      // may run the worker with the host network if namespaces are unavailable.
      args = ["-n", executable("unshare"), "--net", `--setgid=${process.getgid!()}`, `--setuid=${process.getuid!()}`,
        "--", "/usr/bin/env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`), bun, "run", worker];
    } else throw new Error("Native stack inventory requires an OS network sandbox");
    const result = spawnSync(command, args, { cwd: scratch, env, encoding: "utf8", timeout: 35_000, maxBuffer: 2 * 1024 * 1024 });
    if (result.error || result.signal || result.status !== 0) {
      // Child stderr is deliberately never returned, even when Bun fails before startup.
      const failure = /^{"error":"native-stack-(setup|import|evaluate)-failed","reason":"(redacted|Invalid native declaration name|Invalid native declaration metadata(?::(?:record|resource|props|env|contribution|data|exports|export|binding)-(?:undefined|object|array|function|string|number|boolean|symbol|bigint))?|Invalid native bindings|Unknown native Worker export kind|Unmatched native workflow export|Invalid native binding contributions)"}$/.exec(result.stdout ?? "");
      throw new Error(failure ? `Native stack inventory ${failure[1]} failed (${failure[2]}); check installed source dependencies and declaration fixtures` :
        "Native stack inventory sandbox failed or timed out; OS network denial and Bun are required");
    }
    try { return validateInventory(JSON.parse(result.stdout)); }
    catch { throw new Error("Native stack inventory returned invalid or unsanitized metadata"); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Metadata stays outside generated architecture output. Every call evaluates fresh source. */
export function discoverStackDetails(root: string): { inventory: StackInventoryRecord[]; workers: WorkerMetadata[]; digest: string } {
  const native = evaluate(root);
  const inventory = native.resources.map(resource => ({
    id: resourceId(resource.type, resource.fqn), kind: resource.type.split(".").at(-1)!,
    source: "alchemy.run.ts", declaredName: resource.declaredName,
    ...(resource.type === "Cloudflare.DurableObject" && resource.fqn.includes("/exports/")
      ? { ownerId: resourceId("Cloudflare.Worker", resource.fqn.slice(0, resource.fqn.lastIndexOf("/exports/"))) } : {}),
  })).sort((a, b) => a.id.localeCompare(b.id));
  return { inventory, workers: native.workers, digest: createHash("sha256").update(JSON.stringify(native)).digest("hex") };
}

export function discoverStackInventory(root: string): StackInventoryRecord[] {
  return discoverStackDetails(root).inventory;
}

export function discoverStack(root: string): StackResource[] {
  return discoverStackInventory(root).map(({ id, kind, source }) => ({ id, kind, source }));
}
