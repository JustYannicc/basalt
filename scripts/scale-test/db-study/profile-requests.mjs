import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { operation } from "./clients.mjs";
import { databaseSnapshot, statementDeltas } from "./db-telemetry.mjs";
export async function runSingleRequests(context) {
  const { out, ports, json, attempt, databaseContainer } = context;
  const save = (name, value) =>
    writeFileSync(join(out, name + ".json"), JSON.stringify(value, null, 2) + "\n");
  const mark = (kind, extra = {}) => {
    const row = { at: Date.now(), kind, ...extra };
    appendFileSync(join(out, "profile-markers.ndjson"), JSON.stringify(row) + "\n");
    return row;
  };
  mark("idle-before-start");
  const idleBeforeStart = databaseSnapshot(databaseContainer);
  await delay(60000);
  const idleBeforeEnd = databaseSnapshot(databaseContainer);
  mark("idle-before-end");
  save("idle-before-database", {
    before: idleBeforeStart,
    after: idleBeforeEnd,
    statements: statementDeltas(idleBeforeStart, idleBeforeEnd),
  });
  const records = [];
  for (const workload of [
    { name: "regular", rate: 1, contentBytes: 512 },
    { name: "framing", rate: 20, contentBytes: 100 },
  ]) {
    for (const protocol of ["messages", "responses", "websocket"]) {
      const phase = "profile-" + workload.name + "-" + protocol;
      await json(ports.mock + "/settings", {
        method: "POST",
        body: JSON.stringify({ ...workload, durationMs: 60000, phase }),
      });
      const before = databaseSnapshot(databaseContainer);
      mark("request-window-start", { phase, protocol, workload });
      const id = "density-op-" + attempt + "-" + workload.name + "-" + protocol;
      const record = await operation(
        ports.node,
        protocol,
        id,
        60000,
        workload.contentBytes,
        workload.rate,
      );
      appendFileSync(
        join(out, "profile-operations.ndjson"),
        JSON.stringify({ phase, ...record }) + "\n",
      );
      mark("client-terminal", { phase, record });
      if (!record.pass) throw Error("STOP: diagnostic model request failed in " + phase);
      // Capture late persistence separately from the stream; it is not extra streaming load.
      await delay(60000);
      mark("completion-capture-end", { phase });
      await json(ports.mock + "/flush");
      const upstream = readFileSync(join(out, "upstream.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((row) => row.id === id);
      if (
        upstream.length !== 2 ||
        upstream[0].event !== "start" ||
        upstream[1].event !== "end" ||
        !upstream[1].completed ||
        upstream[1].textBytes !== record.textBytes
      )
        throw Error("Diagnostic upstream join failed");
      const after = databaseSnapshot(databaseContainer);
      const result = {
        phase,
        workload,
        protocol,
        record,
        upstream,
        before,
        after,
        statements: statementDeltas(before, after),
        completionCaptureSeconds: 60,
        checkoutTrace: "home-sql.ndjson",
      };
      records.push(result);
      save(phase, result);
    }
  }
  mark("idle-after-start");
  const idleAfterStart = databaseSnapshot(databaseContainer);
  await delay(60000);
  const idleAfterEnd = databaseSnapshot(databaseContainer);
  mark("idle-after-end");
  save("idle-after-database", {
    before: idleAfterStart,
    after: idleAfterEnd,
    statements: statementDeltas(idleAfterStart, idleAfterEnd),
  });
  save("profile-complete", {
    complete: true,
    requests: records.length,
    allTerminals: records.every((row) => row.record.pass),
    capabilitiesPollingDuringProfile: false,
    concurrentRequests: 1,
    scope:
      "Diagnostic SQL acquisition/release timing only; never used for capacity or cost. Idle controls and per-request post-terminal60s captures are retained.",
  });
}
