import { parseArgs } from "node:util";
import { open } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { historyObject } from "../src/pool/model-history/record.ts";
import type { BulkStatus } from "../src/pool/model-history/bulk-contract.ts";
import { privateCredential } from "./usage-import-source.ts";
import { fileDigest } from "./usage-import-stream.ts";
import {
  hash,
  prepareBulk,
  readDescriptor,
  verifyDescriptor,
  bulkChunks,
  bulkStatus,
  readGuard,
  BulkCliError,
} from "./usage-import-bulk.ts";

const help = `Usage: node scripts/import-cpamp-bulk.ts <command> [options]

prepare --file METADATA --accepted-manifest IDS_JSONL --accepted-sha256 SHA256
  --account-map-file PRIVATE_MAP --target ORIGIN --caller OWNER --source UUID
  --organization ORG --pool APP --descriptor NEW_PRIVATE_JSON
  Validates every original page hash and stable ID locally. Writes only a descriptor.
  No source calls, source copies or network requests. The accepted files stay unchanged.

upload --descriptor JSON --owner-session-file PRIVATE_COOKIE --receipts NEW_JSONL
  Revalidates all local inputs, begins the durable job and uploads every chunk.
  Does not approve or apply. Rerun explicitly to resume identical immutable uploads.

apply|resume --descriptor JSON --owner-session-file PRIVATE_COOKIE --receipts NEW_JSONL
  --approve EXACT_MANIFEST_DIGEST --guard-file PRIVATE_GUARD_JSON
  Requires the exact prepare digest and the server's account-map acknowledgement.
  Applies remotely, watches status and rereads the guard every 5 seconds.

status|pause --descriptor JSON --owner-session-file PRIVATE_COOKIE --receipts NEW_JSONL
watch --descriptor JSON --owner-session-file PRIVATE_COOKIE --receipts NEW_JSONL
  [--guard-file PRIVATE_GUARD_JSON --approve EXACT_MANIFEST_DIGEST]
  Without a guard, watch only observes. Supplying a guard requires explicit approval.

Guard JSON must have observedAt/expiresAt Unix milliseconds, ready boolean, cpu number,
poolErrors and queryErrors nonnegative integer counts. All fields are mandatory.
Use observations from the external guardian. Never rewrite times or assume missing errors
are zero. Observations expire within 90 seconds. Missing, stale or unsafe guard data sends
ready=false and pauses the job. Watch stops; resume explicitly after the guardian recovers.

Each receipts file is new, private and fsynced before and after requests. HTTP mutations
are never retried automatically. After an uncertain result, use status with a new receipt
path, then explicitly resume the same descriptor. Keep the accepted manifest and map.
The durable worker pauses without a fresh guard; browser windows are not execution hosts.
`;
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: "boolean" },
    file: { type: "string" },
    "accepted-manifest": { type: "string" },
    "accepted-sha256": { type: "string" },
    "account-map-file": { type: "string" },
    target: { type: "string" },
    caller: { type: "string" },
    source: { type: "string" },
    organization: { type: "string" },
    pool: { type: "string" },
    descriptor: { type: "string" },
    "owner-session-file": { type: "string" },
    receipts: { type: "string" },
    approve: { type: "string" },
    "guard-file": { type: "string" },
  },
});
let recovery: Record<string, unknown> = {};
async function main() {
  if (values.help) {
    console.log(help);
    return;
  }
  const command = positionals[0];
  if (
    positionals.length !== 1 ||
    !["prepare", "upload", "apply", "status", "pause", "resume", "watch"].includes(command ?? "")
  )
    throw new BulkCliError("Choose a command; use --help");
  if (!values.descriptor) throw new BulkCliError("Missing descriptor path");
  if (command === "prepare") {
    if (values.approve || values["owner-session-file"] || values.receipts || values["guard-file"])
      throw new BulkCliError("Prepare is local only");
    const descriptor = await prepareBulk({
      file: values.file,
      acceptedManifest: values["accepted-manifest"],
      acceptedSha256: values["accepted-sha256"],
      accountMapFile: values["account-map-file"],
      target: values.target,
      caller: values.caller,
      source: values.source,
      organization: values.organization,
      pool: values.pool,
    });
    const output = await open(values.descriptor, "wx", 0o600);
    try {
      await output.writeFile(`${JSON.stringify(descriptor)}\n`);
      await output.sync();
    } finally {
      await output.close();
    }
    console.log(
      JSON.stringify({
        job: descriptor.definition.job,
        manifestDigest: descriptor.definition.manifestDigest,
        accountMappingDigest: descriptor.definition.accountMappingDigest,
        descriptorSha256: await fileDigest(values.descriptor),
        totalRows: descriptor.definition.manifest.totalRows,
        chunks: descriptor.definition.manifest.chunks.length,
        writes: false,
      }),
    );
    return;
  }
  if (!values["owner-session-file"] || !values.receipts)
    throw new BulkCliError(
      "Network commands require a private owner session and new receipts path",
    );
  for (const key of [
    "file",
    "accepted-manifest",
    "accepted-sha256",
    "account-map-file",
    "target",
    "caller",
    "source",
    "organization",
    "pool",
  ] as const)
    if (values[key] !== undefined)
      throw new BulkCliError("Network commands use only descriptor inputs");
  const descriptor = await readDescriptor(values.descriptor),
    { definition, files } = descriptor;
  const guarded =
    command === "apply" ||
    command === "resume" ||
    (command === "watch" && values["guard-file"] !== undefined);
  if (
    (guarded && (values.approve !== definition.manifestDigest || !values["guard-file"])) ||
    (!guarded && (values.approve !== undefined || values["guard-file"] !== undefined))
  )
    throw new BulkCliError(
      "Apply, resume and guarded watch require the exact approval digest and guard",
    );
  recovery = { job: definition.job, manifestDigest: definition.manifestDigest };
  await verifyDescriptor(descriptor);
  const credential = await privateCredential(values["owner-session-file"]);
  const headers = new Headers({
    "content-type": "application/json",
    cookie: credential,
    origin: files.target,
  });
  const output = await open(values.receipts, "wx", 0o600);
  const append = async (value: unknown) => {
    await output.writeFile(`${JSON.stringify(value)}\n`);
    await output.sync();
  };
  let sequence = 0;
  try {
    await append({
      version: 1,
      command,
      job: definition.job,
      manifestDigest: definition.manifestDigest,
      accountMappingDigest: definition.accountMappingDigest,
    });
    const viewer = await fetch(new URL("/api/viewer", files.target), {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!viewer.ok) {
      await viewer.body?.cancel();
      throw new BulkCliError("Owner sign-in refused");
    }
    if (historyObject(await viewer.json()).userId !== files.caller)
      throw new BulkCliError("Signed-in owner does not match the accepted caller");
    const endpoint = new URL(
      `/api/organizations/${encodeURIComponent(files.organization)}/apps/${encodeURIComponent(files.pool)}/pool-usage/import/bulk`,
      files.target,
    );
    const request = async (operation: string, payload: Record<string, unknown> = {}) => {
      const receipt = {
        sequence: sequence++,
        operation,
        ...(payload.chunk === undefined ? {} : { chunk: payload.chunk }),
        ...(operation === "guard" ? { observation: payload.observation } : {}),
      };
      recovery = { job: definition.job, manifestDigest: definition.manifestDigest, ...receipt };
      await append({ ...receipt, phase: "request", at: Date.now() });
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(
          operation === "upload" || operation === "begin" ? 30_000 : 10_000,
        ),
        body: JSON.stringify({
          operation,
          ...(operation === "begin" ? {} : { job: definition.job }),
          ...payload,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new BulkCliError(`Bulk ${operation} refused with HTTP ${response.status}`);
      }
      const result = bulkStatus(await response.json(), definition);
      await append({ ...receipt, phase: "response", at: Date.now(), result });
      recovery = {
        job: definition.job,
        manifestDigest: definition.manifestDigest,
        lastStatus: result,
      };
      return result;
    };
    const guard = async () => {
      const observation = await readGuard(values["guard-file"]!);
      const observed = await request("guard", { observation });
      if (observation.ready) return observed;
      const paused = await request("pause");
      console.log(JSON.stringify(paused));
      throw new BulkCliError("External guard missing, stale or unsafe; job paused");
    };
    const watch = async (initial: BulkStatus) => {
      let status = initial;
      console.log(JSON.stringify(status));
      while (status.state !== "completed") {
        if (status.state === "paused") return status;
        await setTimeout(5000);
        if (guarded) status = await guard();
        status = await request("status");
        console.log(JSON.stringify(status));
      }
      return status;
    };
    let status: BulkStatus;
    if (command === "upload") {
      status = await request("begin", {
        manifest: definition.manifest,
        accountMappings: definition.accountMappings,
      });
      let index = 0;
      for await (const chunk of bulkChunks(files)) {
        const expected = definition.manifest.chunks[index];
        if (
          !expected ||
          expected.sha256 !== hash(chunk.data) ||
          expected.idsSha256 !== hash(JSON.stringify(chunk.ids)) ||
          expected.rows !== chunk.ids.length ||
          expected.bytes !== Buffer.byteLength(chunk.data)
        )
          throw new BulkCliError("Upload chunk differs from descriptor");
        status = await request("upload", { chunk: index++, data: chunk.data });
      }
      if (index !== definition.manifest.chunks.length)
        throw new BulkCliError("Missing upload chunks");
      console.log(JSON.stringify(status));
    } else if (command === "apply" || command === "resume") {
      status = await request("status");
      await guard();
      status =
        command === "apply"
          ? await request("approve", {
              manifestDigest: definition.manifestDigest,
              accountMappingDigest: definition.accountMappingDigest,
            })
          : await request("resume");
      if (command === "apply" && status.state === "paused" && status.reason === "operator_paused")
        status = await request("resume");
      status = await watch(status);
    } else if (command === "watch") {
      status = guarded ? await guard() : await request("status");
      status = await watch(status);
    } else {
      status = await request(command!);
      console.log(JSON.stringify(status));
    }
    await append({ complete: true, state: status.state, at: Date.now() });
  } finally {
    await output.close();
  }
}
try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify({
      stopped: true,
      ...recovery,
      reason:
        error instanceof BulkCliError
          ? error.message
          : "Transport failure, invalid input or unverified response",
      recovery:
        "No automatic retry. Inspect the private receipts and use status with a new receipts path. Explicitly resume the same descriptor after reconciling an uncertain request. Use --help for arguments and strict guard fields.",
    }),
  );
  process.exitCode = 1;
}
