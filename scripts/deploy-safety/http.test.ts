import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { reportFailure } from "../failure/report.ts";
import { requestJson } from "./http.ts";

test("a request that fails before a response keeps fetch's cause for the report", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  const secret = "pscale-token-0123456789abcdef";

  // The real fetch against an address nothing listens on.
  const failure = await requestJson(
    fetch,
    "PlanetScale",
    `http://127.0.0.1:${port}/v1/organizations/basalt-org/databases/basalt/branches/main/backups`,
    { headers: { Authorization: `fixture-id:${secret}` } },
  ).then(
    () => assert.fail("The request was expected to fail"),
    (error: unknown) => error,
  );
  const lines: string[] = [];
  const report = await reportFailure(failure, {
    title: "Backup stopped",
    environment: { PLANETSCALE_SERVICE_TOKEN: secret },
    write: (line) => lines.push(line),
  });

  assert.match(
    lines[0]!,
    /^Backup stopped: SafetyGateError: PlanetScale request failed before a response\n/,
  );
  assert.equal(report.error.code, "release.UNREACHABLE");
  assert.match(lines[0]!, /\n {2}why: It was caused by Error ECONNREFUSED\./);
  assert.match(
    lines[0]!,
    /\n {2}fix: The service was not reached, so nothing changed there\. Rerun/,
  );
  assert.match(
    lines[0]!,
    /\n {2}cause 1: TypeError: fetch failed\n {2}cause 2: Error ECONNREFUSED/,
  );
  for (const leak of [secret, "127.0.0.1", "basalt-org"])
    assert.ok(!lines.join("\n").includes(leak), leak);
});
