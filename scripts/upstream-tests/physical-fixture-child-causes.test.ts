import * as NodeServices from "@effect/platform-node/NodeServices";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Effect } from "effect";
import { ChildProcess } from "effect/process";
import { fixtureProcessOutput } from "../../.upstream/e2e/support/fixture-diagnostics.ts";
import { copyE2eEvidence } from "../e2e-evidence.ts";

test("the actual readiness child retains its underlying PostgreSQL connection failure", async (t) => {
  const directory = await mkdtemp(
    join(process.env.RUNNER_TEMP ?? tmpdir(), "physical-child-cause-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fields = Buffer.from("SERROR\0VERROR\0CXX000\0Mforced fixture connection failure\0\0");
  const length = Buffer.alloc(4);
  length.writeInt32BE(fields.length + 4);
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    socket.once("data", () => socket.end(Buffer.concat([Buffer.from("E"), length, fields])));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const configuration = join(directory, "database.json");
  await writeFile(
    configuration,
    JSON.stringify({
      database: `postgresql://fixture:fixture-only@127.0.0.1:${address.port}/fixture?sslmode=disable`,
    }),
    { mode: 0o600 },
  );
  const result = await Effect.runPromise(
    Effect.scoped(
      fixtureProcessOutput(
        directory,
        ChildProcess.make(
          process.execPath,
          ["apps/hosted/testing/production-ops-provisioning-fixture.ts", configuration],
          {
            cwd: fileURLToPath(new URL("../../.upstream/", import.meta.url)),
            env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
            extendEnv: false,
            stdout: "pipe",
            stderr: "pipe",
          },
        ),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  assert.equal(connections, 1, "the real pg client must receive the forced backend error");
  assert.equal(result.exitCode, 1);
  const retained = join(directory, "retained");
  copyE2eEvidence(directory, retained);
  const diagnostics = join(retained, "report/diagnostics");
  const texts = await Promise.all(
    (await readdir(diagnostics)).map((file) => readFile(join(diagnostics, file), "utf8")),
  );
  assert.ok(
    texts.some((text) => text.includes("forced fixture connection failure")),
    "the child must retain the original SQL failure rather than only its wrapper",
  );
  assert.ok(
    texts.some((text) => text.includes("XX000")),
    "the original SQLSTATE must survive",
  );
});
