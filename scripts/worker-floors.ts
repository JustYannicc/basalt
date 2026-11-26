import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Upload = { readonly worker: string; readonly bytes: number; readonly budget: number };
type Floor = { readonly warn: number; readonly fail: number };
type Finding = {
  readonly level: "error" | "warning";
  readonly worker: string;
  readonly message: string;
};

/**
 * Bytes each Worker keeps free under its upload budget (upstream's `uploadBudgets`). The budget
 * stops a deploy; the fail level stops a pull request first, so the room under it is left for what
 * no single pull request is checked against: a batch of changes that each pass alone, an upstream
 * sync, or a fix that has to ship. The warn level names the growth while the change still passes.
 * Others warn below 5% left, where upstream's report flags a Worker low, and fail below 3%.
 */
export const uploadFloors: Readonly<Record<string, Floor>> = {
  // The dashboard grows with every page. A tenth stays free; the band above it holds several
  // pages' growth, so the trend shows for a while before a pull request fails.
  dashboard: { warn: 585_000, fail: 390_000 },
  "app-pages": { warn: 100_000, fail: 75_000 },
};
const defaultShares = { warn: 0.05, fail: 0.03 };

export const floorOf = (upload: Upload): Floor =>
  uploadFloors[upload.worker] ?? {
    warn: Math.ceil(upload.budget * defaultShares.warn),
    fail: Math.ceil(upload.budget * defaultShares.fail),
  };

const bytes = (value: number) => value.toLocaleString("en-US");

/**
 * A Worker below its warn level warns, and below its fail level fails, when the change added bytes
 * to it or the base's sizes are unknown. A change that did not grow a Worker already below its
 * fail level only warns, so one oversized base does not fail every unrelated pull request.
 */
export function checkFloors(
  head: Iterable<Upload>,
  base: ReadonlyMap<string, Upload> | undefined,
): Finding[] {
  const findings: Finding[] = [];
  for (const upload of head) {
    const left = upload.budget - upload.bytes;
    const floor = floorOf(upload);
    if (left >= floor.warn) continue;
    const before = base === undefined ? undefined : (base.get(upload.worker)?.bytes ?? 0);
    const added = before === undefined ? undefined : upload.bytes - before;
    const below = left < floor.fail;
    const fails = below && (added === undefined || added > 0);
    findings.push({
      level: fails ? "error" : "warning",
      worker: upload.worker,
      message:
        `The ${upload.worker} Worker leaves ${bytes(left)} bytes of its ${bytes(upload.budget)}-byte ` +
        (below
          ? `upload budget, below its ${bytes(floor.fail)}-byte fail level. `
          : `upload budget, below its ${bytes(floor.warn)}-byte warn level; it fails below ${bytes(floor.fail)}. `) +
        (added === undefined
          ? "The base's upload sizes were not available, so the bytes this change added are unknown."
          : `This change added ${bytes(added)} bytes compared with the base ` +
            `(${bytes(before!)} to ${bytes(upload.bytes)}).`) +
        (fails
          ? " Make room before merging; the job summary names the packages that grew."
          : below
            ? " It did not grow the Worker, so it does not fail."
            : ""),
    });
  }
  return findings;
}

/** The upload records `writeWorkerUpload` left in a directory, by Worker; undefined if none. */
export function readUploads(directory: string) {
  if (!existsSync(directory)) return undefined;
  const uploads = new Map<string, Upload>();
  for (const file of readdirSync(directory).toSorted()) {
    if (!file.endsWith(".json")) continue;
    const { worker, bytes, budget } = JSON.parse(readFileSync(join(directory, file), "utf8"));
    uploads.set(worker, { worker, bytes, budget });
  }
  return uploads;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const head = readUploads(
    fileURLToPath(
      new URL("../.upstream/apps/hosted/cloud/.generated/worker-uploads/", import.meta.url),
    ),
  );
  if (head === undefined || head.size === 0)
    throw new Error("No Worker upload records: run node scripts/worker-build.ts first");
  const flag = process.argv.indexOf("--base");
  const base = flag === -1 ? undefined : readUploads(resolve(process.argv[flag + 1] ?? ""));
  const findings = checkFloors(head.values(), base?.size ? base : undefined);
  for (const finding of findings)
    console.log(
      `::${finding.level} title=${finding.worker} Worker upload floor::${finding.message}`,
    );
  if (findings.some((finding) => finding.level === "error")) process.exitCode = 1;
  else console.log(`${head.size} Workers checked against their upload floors; none fails.`);
}
