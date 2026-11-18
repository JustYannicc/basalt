import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Cause, Data, Effect, Exit } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { captureChild } from "./failure/child.ts";
import { createError, reportFailure, structuredFailure } from "./failure/report.ts";

const token = "cf-token-0123456789abcdef";
const account = "0123456789abcdef0123456789abcdef";
const environment = { CLOUDFLARE_API_TOKEN: token };

/** The shape of the release entry's refusals: a tagged error with the reason, the fix and a cause. */
class LiveModuleUnavailable extends Data.TaggedError("LiveModuleUnavailable")<{
  readonly script: string;
  readonly why: string;
  readonly fix: string;
  readonly cause?: unknown;
}> {}
class PlanRefused extends Data.TaggedError("PlanRefused")<{
  readonly violations: readonly {
    rule: string;
    fqn: string;
    type: string;
    action: string;
    change: readonly string[];
    why: string;
    fix: string;
  }[];
}> {}

/** What a person sees: the lines on the error output and the step summary file. */
async function reported(context: TestContext, error: unknown, title = "Release stopped") {
  const directory = mkdtempSync(join(tmpdir(), "basalt-failure-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const summaryPath = join(directory, "summary.md");
  const lines: string[] = [];
  const report = await reportFailure(error, {
    title,
    summaryPath,
    environment,
    write: (line) => lines.push(line),
  });
  return {
    report,
    line: lines[0]!,
    annotation: lines[1]!,
    summary: readFileSync(summaryPath, "utf8"),
  };
}

/** A real request through Effect's fetch client; the failure is whatever that client raises. */
async function requestFailure(request: HttpClientRequest.HttpClientRequest) {
  const exit = await Effect.runPromiseExit(
    HttpClient.execute(request.pipe(HttpClientRequest.bearerToken(token))).pipe(
      Effect.provide(FetchHttpClient.layer),
    ),
  );
  assert.ok(Exit.isFailure(exit));
  return Cause.squash(exit.cause);
}

/** A local address nothing listens on any more. */
async function closedOrigin() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

const path = `/client/v4/accounts/${account}/workers/scripts/basalt-pool-private/content/v2`;
const leaks = [token, account, "basalt-pool-private", "127.0.0.1", "Bearer cf-token"];

test("a transport failure reaches the error line and the summary with its cause chain", async (context) => {
  const origin = await closedOrigin();
  const failure = await requestFailure(HttpClientRequest.get(`${origin}${path}?token=${token}`));
  const { line, annotation, summary, report } = await reported(context, failure);

  assert.equal(report.error.code, "release.UNREACHABLE");
  assert.match(
    line,
    /^Release stopped: HttpClientError TransportError: GET \/client\/v4\/accounts\/\{id\}\/workers\/scripts\/\{id\}\/content\/v2/,
  );
  assert.match(line, /\n {2}why: It was caused by Error ECONNREFUSED\./);
  assert.match(line, /\n {2}fix: The service was not reached, so nothing changed there\. Rerun/);
  assert.match(line, /\n {2}cause 1: TypeError: fetch failed\n {2}cause 2: Error ECONNREFUSED/);
  assert.match(
    annotation,
    /^::error title=Release stopped::Release stopped%3A|^::error title=Release stopped::Release stopped: /,
  );
  assert.ok(annotation.includes("%0A  cause 2: Error ECONNREFUSED"));
  assert.match(summary, /^## Release stopped\n\n\*\*HttpClientError TransportError: GET /);
  assert.match(summary, /- \*\*Cause 2:\*\* Error ECONNREFUSED/);
  for (const leak of leaks) assert.ok(![line, annotation, summary].join("\n").includes(leak), leak);
});

test("a request that can never succeed is not offered a rerun", async (context) => {
  const origin = await closedOrigin();
  // A read that carries a body: fetch refuses it before anything is sent.
  const failure = await requestFailure(
    HttpClientRequest.get(`${origin}${path}`).pipe(HttpClientRequest.bodyText("{}")),
  );
  const { line, report } = await reported(context, failure);

  assert.equal(report.error.code, "release.REQUEST_FAILED");
  assert.match(line, /cause 1: TypeError: Request with GET\/HEAD method cannot have body/);
  assert.match(line, /fix: The request failed the same way it will on a rerun\./);
  assert.doesNotMatch(line, /Rerun;/);
});

test("a refusal keeps the reason and fix its author wrote, above the transport cause", async (context) => {
  const origin = await closedOrigin();
  const refusal = new LiveModuleUnavailable({
    script: "PoolWorker",
    why: "The live script's main module could not be read.",
    fix: "Do not run the class change; read the live script again.",
    cause: await requestFailure(HttpClientRequest.get(`${origin}${path}`)),
  });
  const { line, summary, report } = await reported(context, refusal);

  assert.equal(report.error.code, "LiveModuleUnavailable");
  assert.equal(report.error.why, "The live script's main module could not be read.");
  assert.equal(report.error.fix, "Do not run the class change; read the live script again.");
  assert.match(
    line,
    /\n {2}why: The live script's main module could not be read\.\n {2}fix: Do not run the class change/,
  );
  assert.match(line, /\n {2}script: PoolWorker\n/);
  assert.match(
    line,
    /\n {2}cause 1: HttpClientError TransportError: GET \/client\/v4\/accounts\/\{id\}/,
  );
  assert.match(line, /\n {2}cause 3: Error ECONNREFUSED/);
  assert.match(summary, /- \*\*Why:\*\* The live script's main module could not be read\./);
  assert.match(summary, /- \*\*Fix:\*\* Do not run the class change; read the live script again\./);
  for (const leak of leaks) assert.ok(![line, summary].join("\n").includes(leak), leak);
});

test("every violation of a refused plan is listed with its own reason and fix", async (context) => {
  const violation = (rule: string, fqn: string) => ({
    rule,
    fqn,
    type: "Cloudflare.Worker",
    action: "update",
    change: ["bindings.PoolRuntimeBlue: present -> absent"],
    why: `${rule}: the running code may still read it.`,
    fix: `Restore ${fqn}'s binding.`,
  });
  const { line, summary, report } = await reported(
    context,
    new PlanRefused({
      violations: [violation("binding-removed", "PoolWorker"), violation("binding-added", "Api")],
    }),
  );

  assert.equal(report.error.message, "2 violations refused this step");
  assert.match(
    line,
    /\n {2}violation: binding-removed PoolWorker Cloudflare\.Worker update\n {4}change: bindings\.PoolRuntimeBlue: present -> absent\n {4}why: binding-removed: the running code may still read it\.\n {4}fix: Restore PoolWorker's binding\./,
  );
  assert.match(line, /\n {2}violation: binding-added Api /);
  assert.match(summary, /why: binding-added: the running code may still read it\./);
});

test("a failed command reaches the error line and the summary with the end of its output", async (context) => {
  const script = `
    console.log("Plan: 2 to update");
    console.error("PoolWorker (Cloudflare.Worker) update failed");
    console.error("CloudflareHttpError: PUT https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/pool 400");
    console.error("  code 10021: Script startup exceeded CPU time limit");
    console.error("  Authorization: Bearer ${token}");
    process.exit(1);`;
  const failure = await captureChild(process.execPath, ["-e", script], {
    env: { ...environment, PATH: process.env.PATH },
  }).then(
    () => assert.fail("The command was expected to fail"),
    (error: unknown) => error,
  );
  const { line, annotation, summary, report } = await reported(
    context,
    new Error("Preview deploy failed", { cause: failure }),
    "Preview stopped",
  );

  assert.equal(report.error.code, "release.CHILD_FAILED");
  assert.match(line, /^Preview stopped: node failed with exit 1\n/);
  assert.match(
    line,
    /\n {2}why: A command this step ran did not succeed\. Its last output lines are below\./,
  );
  assert.match(line, /\n {2}fix: Fix what the output names and rerun this step\./);
  assert.match(
    line,
    /\n {4}--- stdout\n {4}Plan: 2 to update\n {4}--- stderr\n {4}PoolWorker \(Cloudflare\.Worker\) update failed\n {4}CloudflareHttpError: PUT \[url\] 400\n {6}code 10021: Script startup exceeded CPU time limit\n {6}Authorization: Bearer \[redacted\]/,
  );
  assert.ok(annotation.includes("code 10021: Script startup exceeded CPU time limit"));
  assert.match(
    summary,
    /Last output lines, credentials removed:\n\n```text\n--- stdout\nPlan: 2 to update\n/,
  );
  assert.match(summary, /code 10021: Script startup exceeded CPU time limit/);
  for (const leak of [token, account, "api.cloudflare.com"])
    assert.ok(![line, annotation, summary].join("\n").includes(leak), leak);
});

test("a command that prints past its limit is stopped and says so", async () => {
  const failure = await captureChild(
    process.execPath,
    ["-e", "setInterval(() => console.log('x'.repeat(4096)), 1)"],
    { maximumOutputBytes: 64 * 1024 },
  ).then(
    () => assert.fail("The command was expected to be stopped"),
    (error: unknown) => error,
  );
  assert.match(String(failure), /printed more than its output limit and was stopped/);
});

test("an unclassified failure is reported without its message's private parts", async (context) => {
  const failure = new Error(
    `Could not reach https://pr-41.preview.example.dev for 'Jane Doe' <jane@example.com> with password=${token}`,
  );
  const { line, report } = await reported(context, failure);

  assert.equal(report.error.code, "release.UNEXPECTED");
  assert.match(line, /^Release stopped: Error: Could not reach \[url\] for \[value\]/);
  assert.match(line, /\n {2}why: It carries no cause, so its message is all that is known\./);
  for (const leak of ["preview.example.dev", "Jane Doe", "jane@example.com", token])
    assert.ok(!line.includes(leak), leak);
});

test("an evlog error is reported as written, and nothing printed reaches the original cause", async (context) => {
  const error = createError({
    code: "release.BACKUP_MISSING",
    message: "No backup covers this release",
    why: "The newest backup is older than the candidate.",
    fix: "Run the backup step, then plan again.",
    link: "https://example.com/runbook",
    cause: new Error(`upstream said token=${token}`),
  });
  const { line } = await reported(context, error);
  assert.match(
    line,
    /^Release stopped: No backup covers this release\n {2}code: release\.BACKUP_MISSING\n {2}why: The newest backup is older than the candidate\.\n {2}fix: Run the backup step, then plan again\.\n {2}link: https:\/\/example\.com\/runbook\n {2}cause 1: Error$/,
  );

  const wrapped = structuredFailure(
    new TypeError(`fetch failed for ${token}`, { cause: error }),
    environment,
  );
  assert.ok(
    !JSON.stringify([String(wrapped.error), wrapped.error.toJSON(), wrapped.error.cause]).includes(
      token,
    ),
  );
});
