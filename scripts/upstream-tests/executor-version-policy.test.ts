import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { executorMarkerPolicy } from "../deploy-safety/executor-marker.ts";
import { executorVersionPolicy } from "../../.upstream/apps/hosted/cloud/src/implementation/executor-version-policy.ts";

const candidate = "b".repeat(40);
const input = {
  candidate,
  attempt: "00000000-0000-4000-8000-000000000001",
  directory: "/fixture/receipts",
  policy: executorMarkerPolicy(candidate),
};

test("fresh self-host and preview setup have no production precondition", () => {
  assert.equal(executorVersionPolicy({}), undefined);
  assert.equal(executorVersionPolicy({ policy: "ambient garbage" }), undefined);
  assert.equal(executorVersionPolicy(input)?.precondition, null);
});

test("a production attempt requires a policy for its exact immutable candidate", () => {
  for (const invalid of [
    { ...input, policy: undefined },
    { ...input, policy: "not JSON" },
    { ...input, candidate: "c".repeat(40) },
    { ...input, attempt: "../other-attempt" },
    { ...input, directory: undefined },
  ])
    assert.throws(() => executorVersionPolicy(invalid), /policy is missing or invalid/);
});

test("the production command receives the exact cutover marker and transition", () => {
  const precondition = {
    transition: {
      baseGitCommit: "a".repeat(40),
      candidateGitCommit: candidate,
      baseToolsCommit: "f69c667936e4c02c75f9d7cc79fb750c230839b9",
      candidateToolsCommit: "2f4c398f3906e0570f0e25a16fa3602329baba29",
    },
    marker: "public.private_executor_settings.key=version",
    expected: "4.0.29",
  } as const;
  const policy = executorMarkerPolicy(candidate, precondition);
  assert.deepEqual(executorVersionPolicy({ ...input, policy })?.precondition, precondition);
  assert.throws(
    () => executorVersionPolicy({ ...input, policy: policy.replace("4.0.29", "4.0.28") }),
    /policy is missing or invalid/,
  );
});

test("the actual migration command refuses missing or invalid release inputs before opening SQL", async () => {
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    for (const invalid of [
      { ...input, candidate: undefined, policy: undefined, directory: undefined },
      { ...input, candidate: undefined },
      { ...input, policy: undefined },
      { ...input, directory: undefined },
      { ...input, policy: "not JSON" },
      { ...input, candidate: "c".repeat(40) },
      { ...input, directory: "" },
    ]) {
      const child = spawn(process.execPath, ["src/migrate.ts"], {
        cwd: fileURLToPath(new URL("../../.upstream/apps/hosted/cloud/", import.meta.url)),
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: `postgresql://fixture:fixture@127.0.0.1:${address.port}/fixture`,
          BETTER_AUTH_URL: "https://dashboard.fixture.invalid",
          BETTER_AUTH_SECRET: "fixture-only-secret-0123456789abcdef0123",
          GOOGLE_CLIENT_ID: "fixture",
          GOOGLE_CLIENT_SECRET: "fixture",
          GITHUB_CLIENT_ID: "fixture",
          GITHUB_CLIENT_SECRET: "fixture",
          BASALT_RELEASE_ATTEMPT: invalid.attempt,
          BASALT_RELEASE_CANDIDATE: invalid.candidate,
          BASALT_EXECUTOR_MARKER_POLICY: invalid.policy,
          BASALT_RELEASE_EVIDENCE_DIRECTORY: invalid.directory,
        },
        timeout: 15_000,
      });
      let output = "";
      child.stdout.on("data", (data) => (output += data));
      child.stderr.on("data", (data) => (output += data));
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert.equal(code, 1, output);
      assert.match(
        output,
        /Executor migration marker policy is missing or invalid; migration not started/,
      );
      assert.equal(connections, 0, "invalid release inputs must refuse before opening SQL");
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
