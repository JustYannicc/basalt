import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cloudflare, object, string } from "./cloudflare.ts";
import { operate, type Receipt } from "./operation.ts";
import { UpgradeRefusal, workerId, type Candidate } from "./plan.ts";

const output = resolve(process.env.STATE_UPGRADE_OUTPUT_DIRECTORY ?? ".local/state-store-upgrade");
await mkdir(output, { recursive: true, mode: 0o700 });
const summary = process.env.GITHUB_STEP_SUMMARY;
let latestReceipt: Receipt | undefined;
const save = async (receipt: Receipt) => {
  const text = JSON.stringify(receipt, null, 2) + "\n";
  await writeFile(resolve(output, "receipt.tmp"), text, { mode: 0o600 });
  await rename(resolve(output, "receipt.tmp"), resolve(output, "receipt.json"));
  latestReceipt = receipt;
};
try {
  const mode = process.env.STATE_UPGRADE_MODE ?? "dry-run";
  if (mode !== "dry-run" && mode !== "apply")
    throw new UpgradeRefusal(workerId, "mode", "dry-run or apply", "invalid");
  const directory = resolve(string(process.env.STATE_UPGRADE_BUNDLE_DIRECTORY, "bundle-directory"));
  const manifest = object(
    JSON.parse(await readFile(resolve(directory, "upgrade-bundle.json"), "utf8")),
  );
  const compatibility = object(manifest.compatibility);
  if (
    !Array.isArray(manifest.files) ||
    !Array.isArray(compatibility.flags) ||
    compatibility.flags.some((flag) => typeof flag !== "string")
  )
    throw new UpgradeRefusal(
      workerId,
      "bundle-manifest",
      "file list and compatibility flags",
      "invalid",
    );
  const files = manifest.files.map((name: unknown) => string(name, "bundle-file"));
  const main = string(manifest.main, "bundle-main");
  if (
    !files.length ||
    new Set(files).size !== files.length ||
    !files.includes(main) ||
    files.some((file) => !/^[A-Za-z0-9_-]+\.js$/.test(file))
  )
    throw new UpgradeRefusal(
      workerId,
      "bundle-files",
      "unique local JavaScript modules",
      "invalid",
    );
  const candidate: Candidate = {
    main,
    compatibility: {
      date: string(compatibility.date, "compatibility-date"),
      flags: compatibility.flags,
    },
    files: await Promise.all(
      files.map(async (name) => ({
        name,
        type: "application/javascript+module",
        bytes: new Uint8Array(await readFile(resolve(directory, name))),
      })),
    ),
  };
  const receipt = await operate({
    mode,
    candidate,
    save,
    api: cloudflare(
      process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
      process.env.CLOUDFLARE_API_TOKEN ?? "",
    ),
    expected: {
      workerId: process.env.STATE_UPGRADE_EXPECTED_WORKER_ID ?? "",
      deploymentId: process.env.STATE_UPGRADE_EXPECTED_DEPLOYMENT_ID ?? "",
      namespaceId: process.env.STATE_UPGRADE_EXPECTED_NAMESPACE_ID ?? "",
      version: process.env.STATE_UPGRADE_EXPECTED_VERSION ?? "",
      planSha256: process.env.STATE_UPGRADE_EXPECTED_PLAN_SHA256 ?? "",
    },
  });
  console.log(JSON.stringify(receipt, null, 2));
  if (summary)
    await writeFile(
      summary,
      `## State Worker upgrade\n\n\`\`\`json\n${JSON.stringify(receipt, null, 2)}\n\`\`\`\n`,
      { flag: "a" },
    );
} catch (error) {
  if (!latestReceipt)
    await save({
      schemaVersion: 1,
      mode: process.env.STATE_UPGRADE_MODE === "apply" ? "apply" : "dry-run",
      phase: "preflight",
      startedAt: new Date().toISOString(),
      error:
        error instanceof UpgradeRefusal
          ? {
              resource: error.resource,
              property: error.property,
              expected: error.expected,
              observed: error.observed,
            }
          : {
              resource: workerId,
              property: "preflight",
              expected: "valid local inputs",
              observed: "invalid",
            },
    });
  const safe =
    error instanceof UpgradeRefusal
      ? error.message
      : "State Worker upgrade failed before provider execution";
  console.error(safe);
  if (summary)
    await writeFile(summary, `## State Worker upgrade refused\n\n${safe}\n`, { flag: "a" });
  process.exitCode = 1;
}
