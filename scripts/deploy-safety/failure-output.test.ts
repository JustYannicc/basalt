import assert from "node:assert/strict";
import test from "node:test";
import { OutputTail, redactFailureOutput } from "./failure-output.ts";
import { runCommand } from "./release-runner.ts";

test("failure output removes credentials but keeps the error readable", () => {
  const environment = {
    CLOUDFLARE_API_TOKEN: "cf-token-value",
    ALCHEMY_STAGE: "production",
    HOME: "/home/runner",
  };
  const output = [
    "\u001b[31mError\u001b[0m: request failed with cf-token-value",
    "connecting to postgresql://role:hunter2@aws.connect.psdb.cloud/postgres",
    "Authorization: Bearer abc.def.ghi",
    "derived secret a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
    "stage production at /home/runner/work/basalt/basalt/.upstream/apps/hosted/cloud",
  ].join("\n");
  const redacted = redactFailureOutput(output, environment);
  assert.doesNotMatch(redacted, /cf-token-value|hunter2|abc\.def\.ghi|a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8|\u001b/);
  assert.match(redacted, /^Error: request failed with \[redacted\]$/m);
  assert.match(redacted, /postgresql:\/\/\[redacted\]@aws\.connect\.psdb\.cloud\/postgres/);
  assert.match(redacted, /stage production at \/home\/runner\/work\/basalt\/basalt\/\.upstream\/apps\/hosted\/cloud/);
});

test("failure output keeps only a bounded tail", () => {
  const tail = new OutputTail();
  for (let line = 0; line < 5000; line += 1) tail.push(Buffer.from(`line ${line}\n`));
  const lines = redactFailureOutput(tail.text(), {}).split("\n");
  assert.equal(lines.length, 60);
  assert.equal(lines.at(-1), "line 4999");
});

test("a failed command reports its redacted output tail and a successful one stays silent", async () => {
  const reports: string[] = [];
  const env = { ...process.env, DEPLOY_SECRET: "super-secret-value" };
  const failed = await runCommand(process.execPath, ["-e", "console.error('boom super-secret-value'); process.exit(4)"], process.cwd(), env, (text) => reports.push(text));
  assert.deepEqual(failed, { started: true, exitCode: 4 });
  assert.equal(reports.length, 1);
  assert.match(reports[0]!, /exited with 4/);
  assert.match(reports[0]!, /boom \[redacted\]/);
  assert.doesNotMatch(reports[0]!, /super-secret-value/);
  const passed = await runCommand(process.execPath, ["-e", "console.log('fine')"], process.cwd(), env, (text) => reports.push(text));
  assert.deepEqual(passed, { started: true, exitCode: 0 });
  assert.equal(reports.length, 1);
});
