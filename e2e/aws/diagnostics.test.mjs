import assert from "node:assert/strict";
import { test } from "node:test";
import { AwsOutputTail, awsFailureSummary } from "./diagnostics.ts";

test("a child assertion retains its phase and source position through the wrapper", () => {
  const child = awsFailureSummary({
    code: 1,
    phase: "oauth",
    checks: 23,
    stderr:
      "AssertionError: credential=private-token\n at /private/checkout/e2e/aws/oauth.mjs:51:5",
  });
  const summary = awsFailureSummary({
    ...child,
    code: 1,
    timedOut: false,
    stderr: "AWS acceptance proof failed; private diagnostics retained.",
  });
  assert.deepEqual(summary, {
    phase: "oauth",
    checks: 23,
    code: 1,
    timedOut: false,
    kind: "assertion",
    location: "e2e/aws/oauth.mjs:51:5",
  });
  assert.equal(JSON.stringify(summary).includes("private-token"), false);
  assert.equal(JSON.stringify(summary).includes("/private/checkout"), false);
});

test("module-load failures need no runtime context or screenshot", () => {
  assert.deepEqual(
    awsFailureSummary({
      code: 1,
      stderr:
        "error: Cannot find package 'secret-cookie-value'\n at /checkout/e2e/aws/runtime.mjs:24:9",
    }),
    {
      phase: "module-load",
      code: 1,
      timedOut: false,
      kind: "module-resolution",
      location: "e2e/aws/runtime.mjs:24:9",
    },
  );
});

test("browser launch failures retain a safe kind through the wrapper", () => {
  const child = awsFailureSummary({
    code: 1,
    phase: "browser",
    checks: 151,
    stderr:
      "Error: browserType.launch: Target page, context or browser has been closed\nSocket path too long: /private/checkout/session-cookie",
  });
  const summary = awsFailureSummary({
    ...child,
    code: 1,
    timedOut: false,
    stderr: "AWS acceptance proof failed; private diagnostics retained.",
  });
  assert.deepEqual(summary, {
    phase: "browser",
    checks: 151,
    code: 1,
    timedOut: false,
    kind: "browser-launch",
  });
  assert.equal(JSON.stringify(summary).includes("session-cookie"), false);
});

test("the browser launch phase classifies errors without a recognizable exception name", () => {
  assert.deepEqual(
    awsFailureSummary({ phase: "browser", checks: 151, code: 1, stderr: "Opaque private error" }),
    { phase: "browser", checks: 151, code: 1, timedOut: false, kind: "browser-launch" },
  );
});

test("arbitrary context and exception payloads cannot enter the public summary", () => {
  const secret = "session-cookie-and-private-response";
  const summary = awsFailureSummary({
    code: secret,
    timedOut: secret,
    phase: secret,
    checks: secret,
    kind: secret,
    location: `/checkout/e2e/aws/runtime.mjs:42:1 ${secret}`,
    stdout: secret,
    stderr: `Error: ${secret}`,
    token: secret,
  });
  assert.deepEqual(summary, { phase: "unknown", code: null, timedOut: false, kind: "unknown" });
  assert.equal(JSON.stringify(summary).includes(secret), false);
});

test("timeouts preserve the last completed phase and override child error kinds", () => {
  assert.deepEqual(
    awsFailureSummary({
      code: null,
      timedOut: true,
      phase: "server",
      checks: 2,
      kind: "assertion",
    }),
    { phase: "server", checks: 2, code: null, timedOut: true, kind: "timeout" },
  );
});

const { spawn } = await import("node:child_process");
const { once } = await import("node:events");
const { mkdtemp, readFile, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { awsChildFailure, captureAwsChild } = await import("./evidence.ts");

async function killWaitingChild(t) {
  const directory = await mkdtemp(join(tmpdir(), "aws-diagnostic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = `
    import { AwsProgress } from ${JSON.stringify(new URL("./evidence.ts", import.meta.url).href)};
    const progress = new AwsProgress(${JSON.stringify(directory)});
    progress.enter("server", 7);
    process.on("message", () => {});
    process.stdout.write(JSON.stringify({ awsProofPhase: "server", checks: 7, token: "SYNTHETIC_PRIVATE_VALUE" }) + "\\n");
    await new Promise(resolve => process.stderr.write("TypeError: Bearer SYNTHETIC_PRIVATE_VALUE\\n at /private/session-cookie/e2e/aws/runtime.mjs:80:4\\n", resolve));
    process.send("waiting");
    await new Promise(() => {});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  t.after(() => child.kill("SIGKILL"));
  const captured = captureAwsChild(child, directory);
  await once(child, "message");
  child.kill("SIGKILL");
  const output = await captured;
  return { directory, output };
}

test("a killed child retains the phase it entered without reaching catch", async (t) => {
  const { directory, output } = await killWaitingChild(t);
  assert.deepEqual(awsChildFailure(directory, { code: output.code, timedOut: true }), {
    phase: "server",
    checks: 7,
    code: null,
    timedOut: true,
    kind: "timeout",
  });
});

test("a killed child's output tail keeps safe diagnostics and drops arbitrary text", async (t) => {
  const { directory } = await killWaitingChild(t);
  const text = await readFile(join(directory, "child-output-tail.json"), "utf8");
  assert.doesNotMatch(text, /SYNTHETIC_PRIVATE_VALUE|session-cookie|Bearer|\/private/);
  const tail = JSON.parse(text);
  assert.ok(tail.records.some((record) => record.stream === "stdout" && record.phase === "server"));
  assert.ok(tail.records.some((record) => record.stream === "stderr" && record.kind === "type"));
  assert.ok(tail.records.some((record) => record.location === "e2e/aws/runtime.mjs:80:4"));
  assert.ok(Buffer.byteLength(text) <= 16 * 1024);
});

test("the output tail stays bounded across large, partial and secret-shaped lines", () => {
  const tail = new AwsOutputTail();
  const text =
    "TypeError: token=unlabelled-secret-value\n at /private/unknown-cookie/e2e/aws/oauth.mjs:51:5\n";
  const bytes = Buffer.from(text);
  for (let index = 0; index < bytes.length; index++)
    tail.push("stderr", bytes.subarray(index, index + 1));
  assert.ok(tail.text().includes('"kind":"type"'));
  assert.ok(tail.text().includes('"location":"e2e/aws/oauth.mjs:51:5"'));
  tail.push("stdout", Buffer.from("x".repeat(64 * 1024) + "\n"));
  assert.ok(tail.text().includes('"kind":"omitted-line"'));
  for (let index = 0; index < 1000; index++) {
    tail.push(
      "stdout",
      Buffer.from(
        JSON.stringify({
          awsProofPhase: "tools",
          checks: index,
          secret: "unlabelled-secret-value",
          url: "https://private.example/callback?code=unknown-cookie",
        }) + "\n",
      ),
    );
    assert.ok(Buffer.byteLength(tail.text()) <= 16 * 1024);
  }
  tail.push("stderr", Buffer.from("arbitrary fragment with unknown-cookie and 日本語"));
  tail.finish();
  const output = tail.text();
  const parsed = JSON.parse(output);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.records.some((record) => record.phase === "tools" && record.checks === 999));
  assert.doesNotMatch(
    output,
    /unlabelled-secret-value|unknown-cookie|private.example|日本語|callback/,
  );
});

test("CI collects only the safe AWS diagnostics and existing screenshots", async (t) => {
  const { mkdir, writeFile, readdir } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  const { collect } = await import("../../scripts/ci-bundles/artifacts.mjs");
  const { parse } = createRequire(
    new URL("../../scripts/architecture/package.json", import.meta.url),
  )("yaml");
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const artifact = workflow.jobs["aws-connectors"].steps.find((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  const directory = await mkdtemp(join(tmpdir(), "aws-artifact-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace");
  const proof = ".generated/aws-proof/run-held";
  await mkdir(join(workspace, proof), { recursive: true });
  const safe = [
    "phase-context.json",
    "child-output-tail.json",
    "failure-summary.json",
    "aws-paste-step.png",
  ];
  for (const name of [
    ...safe,
    "runtime.json",
    "failure.txt",
    "failure-context.json",
    "proof-input.json",
  ])
    await writeFile(join(workspace, proof, name), name);
  const destination = join(directory, "retained");
  await collect({ artifacts: [artifact.with] }, workspace, {}, destination);
  assert.deepEqual((await readdir(join(destination, "artifacts", proof))).sort(), safe.sort());
});

test("AWS wire fixtures use strings outside provider credential formats", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const name of ["aws-signed-mcp.ts", "aws-identity-fixture.ts"]) {
    const source = await readFile(
      new URL(`../../.upstream/e2e/support/${name}`, import.meta.url),
      "utf8",
    );
    const values = [
      ...source.matchAll(/(?:accessKeyId|secretAccessKey|sessionToken):\s*(["`])([^"`]+)\1/g),
    ];
    assert.equal(values.length, 3, `${name} must expose all three fixture values to this check`);
    for (const [, , expression] of values) {
      const value = expression.replace("${digest}", "ABCDEF012345");
      assert.doesNotMatch(
        value,
        /(?:AKIA|ASIA|AROA|AIDA|AGPA|AIPA|ANPA|ANVA|ASCA|APKA|ABIA|ACCA)[A-Z0-9]{16}/,
      );
      assert.match(value, /^synthetic-[a-z-]+(?:ABCDEF012345)?$/);
      assert.doesNotMatch(value, /^[A-Za-z0-9/+=]{40,}$/);
    }
  }
});
