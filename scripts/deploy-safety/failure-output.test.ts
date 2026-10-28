import assert from "node:assert/strict";
import test from "node:test";
import { isScriptStartupCpuLimit, OutputTail, redactFailureOutput } from "./failure-output.ts";
import { runCommand } from "./release-runner.ts";

test("only Cloudflare's startup CPU-limit rejection counts as a ScriptStartupError worth retrying", () => {
  assert.equal(isScriptStartupCpuLimit("✗ ApiWorker\nScriptStartupError: Script startup exceeded CPU time limit.\n"), true);
  assert.equal(isScriptStartupCpuLimit("\u001b[31mScriptStartupError\u001b[0m { code: 10021, message: \"Script startup exceeded CPU time limit.\" }"), true);
  assert.equal(isScriptStartupCpuLimit("ScriptStartupError: Uncaught Error: missing binding at worker.js:1"), false);
  assert.equal(isScriptStartupCpuLimit("Script startup exceeded CPU time limit."), false);
  assert.equal(isScriptStartupCpuLimit("InvalidWorkerScript: bad module"), false);
});

test("a failed command flags the startup CPU-limit rejection; a passing one never does", async () => {
  const print = "console.error('ScriptStartupError: Script startup exceeded CPU time limit.')";
  const reports: string[] = [];
  const failed = await runCommand(process.execPath, ["-e", `${print}; process.exit(1)`], process.cwd(), process.env, (text) => reports.push(text));
  assert.deepEqual(failed, { started: true, exitCode: 1, scriptStartupCpuLimit: true });
  const passed = await runCommand(process.execPath, ["-e", print], process.cwd(), process.env, (text) => reports.push(text));
  assert.deepEqual(passed, { started: true, exitCode: 0 });
});

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

test("a tail cut by the byte bound drops its partial first line, which could hold half a secret", () => {
  const tail = new OutputTail();
  tail.push(Buffer.from(`{"client_secret":"GOCSPX-shortTail-WxYz12" ${"x".repeat(70 * 1024)}\nlast line\n`));
  const text = tail.text();
  assert.doesNotMatch(text, /WxYz12|GOCSPX/);
  assert.equal(text, "[truncated]\nlast line\n");
  const chunked = new OutputTail();
  chunked.push(Buffer.from(`secret=hunter2-partial ${"y".repeat(40 * 1024)}`));
  chunked.push(Buffer.from(`${"z".repeat(40 * 1024)}\nkept\n`));
  assert.equal(chunked.text(), "[truncated]\nkept\n");
});

test("key-value and multi-@ URL credentials are removed even when they are not in the environment", () => {
  const redacted = redactFailureOutput([
    "password=hunter2 next",
    '{"password":"Tr0ub4dor&3","name":"basalt"}',
    '{"password":"correct horse battery"}',
    "postgres://host/db?password=s3cr3t-short&sslmode=verify-full",
    "postgresql://role:pa@ss@aws.connect.psdb.cloud/postgres",
    "postgres://user:p#ss@db.example.com/db and postgres://user:q?ss@db.example.com/db",
    "secret: abc token=xyz api_key=k1",
    "access_token=ya29.shortTok client_secret=GOCSPX-abc CLOUDFLARE_API_TOKEN=cfshort accessToken=camel1 db_password=dbpw1",
  ].join("\n"), { PADDED_SECRET: "  padded-value-123  " });
  for (const leaked of ["hunter2", "Tr0ub4dor", "&3", "horse", "battery", "s3cr3t-short", "pa@ss", "ss@aws", "p#ss", "q?ss",
    "abc", "xyz", "k1", "ya29", "GOCSPX", "cfshort", "camel1", "dbpw1"])
    assert.ok(!redacted.includes(leaked), leaked);
  assert.match(redacted, /"name":"basalt"/);
  assert.match(redacted, /sslmode=verify-full/);
  assert.match(redacted, /postgresql:\/\/\[redacted\]@aws\.connect\.psdb\.cloud\/postgres/);
  assert.match(redacted, /postgres:\/\/\[redacted\]@db\.example\.com\/db and/);
  assert.equal(redactFailureOutput("value padded-value-123 here", { PADDED_SECRET: "  padded-value-123  " }), "value [redacted] here");
  assert.equal(redactFailureOutput("see https://example.com/path?email=a@b.example", {}), "see https://example.com/path?email=a@b.example");
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

test("stdout and stderr are reported separately so their lines cannot interleave", async () => {
  const reports: string[] = [];
  await runCommand(process.execPath, ["-e", "process.stdout.write('out-line\\n'); process.stderr.write('err-line\\n'); process.exit(2)"], process.cwd(), process.env, (text) => reports.push(text));
  assert.match(reports[0]!, /--- stdout\nout-line\n--- stderr\nerr-line/);
});

test("a signal exit names the signal and a descendant holding the pipes cannot hold the release open", async () => {
  const reports: string[] = [];
  const killed = await runCommand(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"], process.cwd(), process.env, (text) => reports.push(text));
  assert.equal(killed.exitCode, null);
  assert.match(reports[0]!, /exited with SIGKILL/);
  const started = Date.now();
  const orphaned = await runCommand("sh", ["-c", "(sleep 10 &) ; echo parent; exit 1"], process.cwd(), process.env, (text) => reports.push(text));
  assert.equal(orphaned.exitCode, 1);
  // The descendant still holds the output, so a retry could overlap it.
  assert.equal(orphaned.outputHeld, true);
  assert.equal(killed.outputHeld, undefined);
  assert.ok(Date.now() - started < 5000, "release waited for a descendant");
  assert.match(reports[1]!, /parent/);
});
