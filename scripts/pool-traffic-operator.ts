import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { openPoolOperations, type PoolOperationsTarget } from "./pool-operations.ts";
import { historyTrafficPath, trafficSelection } from "../src/pool/model-history/traffic.ts";
import { historyObject } from "../src/pool/model-history/record.ts";

/** The started receipt is written before dispatch, so a lost apply reply is never replayed. */
export async function runTrafficOperator(
  options: PoolOperationsTarget & {
    selection: string;
    plan: string;
    apply?: boolean;
  },
) {
  const selection = await trafficSelection(JSON.parse(await readFile(options.selection, "utf8")));
  let approval: Record<string, unknown> | undefined;
  if (options.apply) {
    const saved = historyObject(JSON.parse(await readFile(options.plan, "utf8")));
    if (
      saved.worker !== options.worker ||
      saved.accountId !== options.accountId ||
      JSON.stringify(saved.selection) !== JSON.stringify(selection) ||
      typeof saved.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(saved.digest)
    )
      throw new Error("Traffic plan target or selection changed");
    approval = { digest: saved.digest, go: true };
  }
  const platform = await openPoolOperations(options);
  try {
    if (approval)
      await writeFile(
        `${options.plan}.result.json`,
        JSON.stringify({ status: "started", ...approval }),
        { mode: 0o600, flag: "wx" },
      );
    const response = await platform.service.fetch(
      new Request(`http://pool-operations${historyTrafficPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selection, ...approval }),
      }),
    );
    if (!response.ok)
      throw new Error(
        `Traffic operation returned HTTP ${response.status}; inspect the private plan and result before retrying`,
      );
    const report = historyObject(await response.json());
    if (approval) {
      if (report.status !== "complete" || report.digest !== approval.digest)
        throw new Error("Unconfirmed traffic apply");
      await writeFile(`${options.plan}.result.json`, JSON.stringify(report), { mode: 0o600 });
    } else {
      if (
        report.status !== "dry-run" ||
        report.writes !== false ||
        typeof report.digest !== "string" ||
        JSON.stringify(report.selection) !== JSON.stringify(selection)
      )
        throw new Error("Invalid traffic dry run");
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
      plan: { type: "string" },
      apply: { type: "boolean" },
      go: { type: "boolean" },
    },
  });
  try {
    if (
      !values.worker ||
      !values["account-id"] ||
      !/^[a-f0-9]{32}$/.test(values["account-id"]) ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(values.worker) ||
      !values.selection ||
      !values.plan ||
      Boolean(values.apply) !== Boolean(values.go)
    )
      throw new Error("Invalid traffic operator options");
    const report = await runTrafficOperator({
      worker: values.worker,
      accountId: values["account-id"],
      selection: values.selection,
      plan: values.plan,
      apply: values.apply,
    });
    console.log(JSON.stringify({ status: report.status, digest: report.digest }));
  } catch {
    console.error("Traffic operation failed. Inspect the private plan and result before retrying.");
    process.exitCode = 1;
  }
}
