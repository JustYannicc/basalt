import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redacted } from "effect";
import { withPoolRegistryPull } from "../deploy-safety/pool-image-metadata.ts";
import type { CloudflareCredentials } from "../deploy-safety/cloudflare.ts";
import { poolDatabase } from "../../src/pool/database-settings.ts";
import {
  decodeHomeSchemaInfo,
  decodeHomeSchemaResult,
  HomeSchemaCommandError,
  type HomeSchemaInfo,
  type NativeHomeCommands,
} from "./home-schema-operation.ts";

export interface AdmittedHomeImage {
  image: string;
  imageDigest: string;
  imageConfigDigest: string;
}
interface CommandResult {
  code: number;
  stdout: string;
}
export type HomeContainerCommand = (
  args: string[],
  options: {
    input?: string;
    timeoutMs: number;
    capture?: boolean;
  },
) => Promise<CommandResult>;
const outputLimit = 32_768;
const containerPattern = /^[a-f0-9]{64}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
type Mode = "-db-schema-info" | "-db-schema-check" | "-db-migrate";

/** Preserve the owned container identity even when Docker cannot confirm its removal. */
export class HomeContainerCleanupError extends HomeSchemaCommandError {
  readonly containerId: string;
  constructor(containerId: string) {
    super("cleanup-failed");
    this.containerId = containerId;
  }
}

/** Child diagnostics never cross this boundary, including spawn and stdin errors. */
const command: HomeContainerCommand = (args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: "command-timeout" | "invalid-receipt" | undefined;
    const timer = setTimeout(() => {
      failure = "command-timeout";
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (options.capture === false) return;
      bytes += chunk.length;
      if (bytes > outputLimit) {
        failure = "invalid-receipt";
        child.kill("SIGKILL");
      } else chunks.push(chunk);
    });
    child.stderr.on("data", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      reject(new HomeSchemaCommandError("command-failed"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(new HomeSchemaCommandError(failure));
      else resolve({ code: code ?? 1, stdout: Buffer.concat(chunks).toString("utf8") });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });

const bootstrap = `import json,os,pathlib,sys
from pool.pool_contract import atomic_write,cluster_yaml,require_tmpfs
value=json.load(sys.stdin)
if set(value)!={"database_url","schema_owner"} or not all(isinstance(v,str) for v in value.values()): raise SystemExit(2)
require_tmpfs(pathlib.Path("/dev/shm"))
root=pathlib.Path("/dev/shm/basalt-schema")
atomic_write(root/"cluster.yaml",cluster_yaml(value["database_url"],value["schema_owner"]))
os.chdir(root)
os.execv("/usr/local/bin/cliproxy-home",["cliproxy-home",sys.argv[1]])`;

function json(result: CommandResult): unknown {
  try {
    if (Buffer.byteLength(result.stdout) > outputLimit) throw new Error();
    return JSON.parse(result.stdout.trim());
  } catch {
    throw new HomeSchemaCommandError("invalid-receipt");
  }
}
async function capturedId(path: string) {
  try {
    const value = (await readFile(path, "utf8")).trim();
    return containerPattern.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function withCandidateHome<T>(options: {
  image: AdmittedHomeImage;
  credentials: CloudflareCredentials;
  databaseUrl: Redacted.Redacted<string>;
  work(commands: NativeHomeCommands & { info: HomeSchemaInfo }): Promise<T>;
  execute?: HomeContainerCommand;
  registry?: typeof withPoolRegistryPull;
}): Promise<T> {
  if (
    !digestPattern.test(options.image.imageDigest) ||
    !digestPattern.test(options.image.imageConfigDigest) ||
    !options.image.image.endsWith(`@${options.image.imageDigest}`)
  )
    throw new HomeSchemaCommandError("image-mismatch");
  const execute: HomeContainerCommand = async (args, settings) => {
    try {
      return await (options.execute ?? command)(args, settings);
    } catch (error) {
      throw error instanceof HomeSchemaCommandError
        ? error
        : new HomeSchemaCommandError("command-failed");
    }
  };
  return (options.registry ?? withPoolRegistryPull)(
    options.image.image,
    options.image.imageDigest,
    options.credentials,
    async ({ username, password }) => {
      const directory = await mkdtemp(join(tmpdir(), "basalt-home-schema-"));
      try {
        await chmod(directory, 0o700);
        await writeFile(
          join(directory, "config.json"),
          JSON.stringify({
            auths: {
              "registry.cloudflare.com": {
                auth: Buffer.from(`${username}:${password}`).toString("base64"),
              },
            },
          }),
          { mode: 0o600 },
        );
        const prefix = ["--config", directory];
        const pull = await execute(
          [...prefix, "pull", "--platform", "linux/amd64", options.image.image],
          { timeoutMs: 180_000, capture: false },
        );
        if (pull.code !== 0) throw new HomeSchemaCommandError("pull-failed");
        const inspected = await execute(
          [...prefix, "image", "inspect", "--format", "{{.Id}}", options.image.image],
          { timeoutMs: 15_000 },
        );
        if (inspected.code !== 0 || inspected.stdout.trim() !== options.image.imageConfigDigest)
          throw new HomeSchemaCommandError("image-mismatch");
        let migrationInvoked = false;
        const invoke = async (mode: Mode, allocated?: (containerId: string) => Promise<void>) => {
          if (mode === "-db-migrate") {
            if (migrationInvoked) throw new HomeSchemaCommandError("command-failed");
            migrationInvoked = true;
          }
          const cidPath = join(directory, `container-${randomUUID()}.cid`);
          const deadline = Date.now() + 660_000;
          let id: string | undefined;
          let outcome: CommandResult | undefined;
          let failed = false;
          let failure: unknown;
          try {
            const args = [
              ...prefix,
              "create",
              "--cidfile",
              cidPath,
              "--platform",
              "linux/amd64",
              "--interactive",
              "--read-only",
              "--cap-drop",
              "ALL",
              "--security-opt",
              "no-new-privileges",
              "--no-healthcheck",
              "--tmpfs",
              "/dev/shm:rw,noexec,nosuid,nodev,mode=1777,size=16m",
              ...(mode === "-db-schema-info" ? ["--network", "none"] : []),
              "--entrypoint",
              mode === "-db-schema-info" ? "/usr/local/bin/cliproxy-home" : "python3",
              options.image.image,
            ];
            args.push(...(mode === "-db-schema-info" ? [mode] : ["-c", bootstrap, mode]));
            const created = await execute(args, { timeoutMs: 30_000, capture: false });
            id = await capturedId(cidPath);
            if (created.code !== 0 || !id) throw new HomeSchemaCommandError("command-failed");
            if (allocated) {
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  allocated(id),
                  new Promise<never>((_, reject) => {
                    timer = setTimeout(
                      () => reject(new HomeSchemaCommandError("command-timeout")),
                      Math.max(1, deadline - Date.now() - 615_000),
                    );
                  }),
                ]);
              } finally {
                clearTimeout(timer);
              }
            }
            const timeoutMs = deadline - Date.now() - 15_000;
            if (timeoutMs <= 0) throw new HomeSchemaCommandError("command-timeout");
            outcome = await execute([...prefix, "start", "--attach", "--interactive", id], {
              ...(mode === "-db-schema-info"
                ? {}
                : {
                    input: JSON.stringify({
                      database_url: Redacted.value(options.databaseUrl),
                      schema_owner: poolDatabase.owner,
                    }),
                  }),
              timeoutMs,
            });
          } catch (error) {
            failed = true;
            failure = error;
          }
          id ??= await capturedId(cidPath);
          if (id) {
            const removed = await execute([...prefix, "rm", "--force", id], {
              timeoutMs: 15_000,
              capture: false,
            }).catch(() => undefined);
            if (!removed || removed.code !== 0) throw new HomeContainerCleanupError(id);
          }
          await rm(cidPath, { force: true });
          if (failed) throw failure;
          if (!outcome) throw new HomeSchemaCommandError("command-failed");
          return outcome;
        };
        const infoResult = await invoke("-db-schema-info");
        if (infoResult.code !== 0) throw new HomeSchemaCommandError("command-failed");
        const info = decodeHomeSchemaInfo(json(infoResult));
        return await options.work({
          info,
          check: () => runResult(invoke, "-db-schema-check", info),
          migrate: (allocated) => runResult((mode) => invoke(mode, allocated), "-db-migrate", info),
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

async function runResult(
  invoke: (mode: Exclude<Mode, "-db-schema-info">) => Promise<CommandResult>,
  mode: Exclude<Mode, "-db-schema-info">,
  info: HomeSchemaInfo,
) {
  const result = await invoke(mode);
  const decoded = decodeHomeSchemaResult(json(result), info);
  const success = ["ready", "migrated", "noop"].includes(decoded.status);
  const allowed =
    mode === "-db-schema-check"
      ? ["ready", "pending", "refused", "failed"]
      : ["migrated", "noop", "refused", "failed"];
  const pendingValid =
    decoded.status !== "pending" ||
    (decoded.applied_version !== null &&
      decoded.applied_version > 0 &&
      decoded.applied_version <= info.target_version &&
      (decoded.applied_version < info.target_version
        ? !decoded.indexes_checked &&
          decoded.pending_indexes.length === 0 &&
          decoded.reason === "schema_pending"
        : decoded.indexes_checked &&
          decoded.pending_indexes.length > 0 &&
          decoded.reason === "indexes_pending"));
  if (
    !allowed.includes(decoded.status) ||
    result.code !== (success ? 0 : 1) ||
    !pendingValid ||
    (mode === "-db-schema-check" && decoded.previous_version !== null) ||
    (!decoded.indexes_checked && decoded.pending_indexes.length !== 0) ||
    (decoded.indexes_checked && decoded.applied_version !== info.target_version) ||
    (success &&
      mode === "-db-migrate" &&
      (decoded.previous_version === null ||
        decoded.previous_version < 1 ||
        decoded.previous_version > info.target_version)) ||
    (success &&
      (decoded.applied_version !== info.target_version ||
        !decoded.indexes_checked ||
        decoded.pending_indexes.length !== 0 ||
        decoded.reason !== undefined ||
        decoded.sqlstate !== undefined)) ||
    (!success && decoded.reason === undefined)
  )
    throw new HomeSchemaCommandError("invalid-receipt");
  return decoded;
}
