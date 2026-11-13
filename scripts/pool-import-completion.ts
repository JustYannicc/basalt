import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { openPoolOperations, type PoolOperationsTarget } from "./pool-operations.ts";
import { verifyCompletionManifest, type CompletionInput } from "./usage-import-completion.ts";
import {
  historyImportCompletionPath,
  importCompletionSelection,
  completionHash,
  completionRefusal,
} from "../src/pool/model-history/import-completion-contract.ts";
import { historyObject } from "../src/pool/model-history/record.ts";

class CompletionRefused extends Error {}

export async function runImportCompletion(
  options: PoolOperationsTarget & {
    selection: string;
    inputs: CompletionInput[];
    plan: string;
    apply?: boolean;
  },
) {
  const selection = importCompletionSelection(
    JSON.parse(await readFile(options.selection, "utf8")),
  );
  const proof = await verifyCompletionManifest(options.inputs, selection);
  let approval: { digest: string; go: true } | undefined;
  if (options.apply) {
    const saved = historyObject(JSON.parse(await readFile(options.plan, "utf8")));
    if (
      saved.worker !== options.worker ||
      saved.accountId !== options.accountId ||
      JSON.stringify(saved.selection) !== JSON.stringify(selection) ||
      !completionHash(saved.digest) ||
      saved.reconciled !== true ||
      (saved.contiguous !== true && saved.alreadyComplete !== true)
    )
      throw new Error("Completion plan target, source or reconciliation changed");
    if (selection.afterSourceId !== "0") {
      const current = historyObject(saved.current);
      if (
        current.upperSourceId !== selection.afterSourceId ||
        !proof.manifestDigests.includes(String(current.manifestDigest))
      )
        throw new Error("Completion inputs do not include the preceding checkpoint manifest");
    }
    approval = { digest: saved.digest, go: true };
  }
  const platform = await openPoolOperations(options);
  try {
    // A started receipt outlives a lost reply and prevents another dispatch with this approval.
    if (approval)
      await writeFile(
        `${options.plan}.result.json`,
        JSON.stringify({ status: "started", ...approval }),
        { mode: 0o600, flag: "wx" },
      );
    const response = await platform.service.fetch(
      new Request(`http://pool-operations${historyImportCompletionPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selection, ...approval }),
      }),
    );
    if (response.status === 409)
      throw new CompletionRefused(completionRefusal(await response.json()));
    if (!response.ok)
      throw new Error(
        `Completion operation returned HTTP ${response.status}; inspect the private plan and receipt before retrying`,
      );
    const report = historyObject(await response.json());
    if (
      JSON.stringify(report.selection) !== JSON.stringify(selection) ||
      !completionHash(report.digest)
    )
      throw new Error("Unconfirmed completion selection");
    if (approval) {
      if (report.status !== "complete" || report.digest !== approval.digest)
        throw new Error("Unconfirmed completion apply");
      await writeFile(`${options.plan}.result.json`, JSON.stringify(report), { mode: 0o600 });
    } else {
      if (report.status !== "dry-run" || report.writes !== false)
        throw new Error("Invalid completion dry run");
      await writeFile(
        options.plan,
        JSON.stringify({ worker: options.worker, accountId: options.accountId, ...report }),
        { mode: 0o600, flag: "wx" },
      );
    }
    return report;
  } finally {
    await platform.close();
  }
}
if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      worker: { type: "string" },
      "account-id": { type: "string" },
      selection: { type: "string" },
      manifest: { type: "string", multiple: true },
      file: { type: "string", multiple: true },
      plan: { type: "string" },
      apply: { type: "boolean" },
      go: { type: "boolean" },
    },
  });
  try {
    if (
      !values.worker ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(values.worker) ||
      !values["account-id"] ||
      !/^[a-f0-9]{32}$/.test(values["account-id"]) ||
      !values.selection ||
      !values.manifest?.length ||
      !values.file?.length ||
      values.file.length !== values.manifest.length ||
      !values.plan ||
      Boolean(values.apply) !== Boolean(values.go)
    )
      throw new Error("Invalid completion operator options");
    const report = await runImportCompletion({
      worker: values.worker,
      accountId: values["account-id"],
      selection: values.selection,
      inputs: values.file.map((file, index) => ({ file, manifest: values.manifest![index]! })),
      plan: values.plan,
      apply: values.apply,
    });
    console.log(JSON.stringify({ status: report.status, digest: report.digest }));
  } catch (error) {
    console.error(
      error instanceof CompletionRefused
        ? error.message
        : "Completion operation failed. Inspect the private plan and receipt before retrying.",
    );
    process.exitCode = 1;
  }
}
