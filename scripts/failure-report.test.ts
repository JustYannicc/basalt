import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
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
  readonly violations: readonly Record<string, unknown>[];
}> {}
class WireRefused extends Data.TaggedError("WireRefused")<{
  readonly resource: string;
  readonly path: string;
  readonly value: string;
  readonly why: string;
  readonly fix: string;
  readonly link?: string;
  readonly code?: string;
  readonly detail?: unknown;
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
  const summary = readFileSync(summaryPath, "utf8");
  return {
    report,
    line: lines[0]!,
    annotation: lines[1]!,
    summary,
    all: `${lines.join("\n")}\n${summary}`,
  };
}

/** A real request through Effect's fetch client, read as JSON; the failure is whatever that client raises. */
async function requestFailure(request: HttpClientRequest.HttpClientRequest) {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const response = yield* client.execute(request.pipe(HttpClientRequest.bearerToken(token)));
      return yield* response.json;
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  assert.ok(Exit.isFailure(exit));
  return Cause.squash(exit.cause);
}

const listening = async (context: TestContext, server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
/** A local address nothing listens on any more. */
async function closedOrigin() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

const path = `/client/v4/accounts/${account}/workers/scripts/basalt-pool-private/content/v2`;
const shape = String.raw`\/client\/v4\/accounts\/\{id\}\/workers\/scripts\/\{id\}\/content\/v2`;
const leaks = [token, account, "basalt-pool-private", "127.0.0.1", "Bearer cf-token"];
const noLeak = (text: string, values: readonly string[] = leaks) => {
  for (const leak of values) assert.ok(!text.includes(leak), leak);
};

test("a transport failure reaches the error line and the summary with its cause chain", async (context) => {
  const origin = await closedOrigin();
  const failure = await requestFailure(HttpClientRequest.get(`${origin}${path}?token=${token}`));
  const { line, annotation, summary, report, all } = await reported(context, failure);

  assert.equal(report.error.code, "release.UNREACHABLE");
  assert.match(
    line,
    new RegExp(`^Release stopped: HttpClientError TransportError: GET ${shape}\\n`),
  );
  assert.match(line, /\n {2}why: It was caused by Error ECONNREFUSED\./);
  assert.match(
    line,
    /\n {2}fix: This request never left, so it changed nothing at the service\. Rerun/,
  );
  assert.match(line, /\n {2}cause 1: TypeError: fetch failed\n {2}cause 2: Error ECONNREFUSED$/);
  assert.equal(
    annotation,
    `::error title=Release stopped::${line.replaceAll("%", "%25").replaceAll("\n", "%0A")}`,
  );
  assert.equal(summary, `## Release stopped\n\n\`\`\`text\n${line}\n\`\`\`\n`);
  noLeak(all);
});

test("a request that can never succeed is not offered a rerun", async (context) => {
  const origin = await closedOrigin();
  // A read that carries a body: fetch refuses it before anything is sent.
  const failure = await requestFailure(
    HttpClientRequest.get(`${origin}${path}`).pipe(HttpClientRequest.bodyText("{}")),
  );
  const { line, report } = await reported(context, failure);

  assert.equal(report.error.code, "release.REQUEST_INVALID");
  assert.match(
    line,
    /\n {2}why: It was caused by TypeError: Request with GET\/HEAD method cannot have body\.\n/,
  );
  assert.match(
    line,
    /fix: The request was refused before it was sent and will be refused again on a rerun\./,
  );
  assert.doesNotMatch(line, /Rerun;|changed nothing|may have reached/);
});

test("a connection lost after the request was sent is never called safe to rerun", async (context) => {
  let received = 0;
  const origin = await listening(
    context,
    createServer((socket) =>
      socket.once("data", (chunk) => {
        received += chunk.length;
        socket.destroy();
      }),
    ),
  );
  const failure = await requestFailure(
    HttpClientRequest.post(`${origin}${path}`).pipe(HttpClientRequest.bodyText('{"write":true}')),
  );
  const { line, report, all } = await reported(context, failure);

  assert.ok(received > 0, "the service received the request");
  assert.equal(report.error.code, "release.OUTCOME_UNKNOWN");
  assert.match(line, /fix: The request may have reached the service\. A read can be rerun\./);
  assert.match(line, /Before rerunning a write, check whether it took effect\./);
  assert.doesNotMatch(line, /changed nothing/);
  noLeak(all);
});

test("an answer that is not HTTP leaves the outcome unknown, not a request to fix", async (context) => {
  const origin = await listening(
    context,
    createServer((socket) => socket.once("data", () => socket.end("private-not-http\r\n\r\n"))),
  );
  const failure = await requestFailure(
    HttpClientRequest.post(`${origin}${path}`).pipe(HttpClientRequest.bodyText('{"write":true}')),
  );
  const { line, report, all } = await reported(context, failure);

  assert.equal(report.error.code, "release.OUTCOME_UNKNOWN");
  assert.match(line, /\n {2}cause 2: HTTPParserError$/);
  assert.doesNotMatch(line, /refused before it was sent|changed nothing/);
  noLeak(all, [...leaks, "private-not-http"]);
});

test("a good answer that cannot be read is never offered a blind rerun", async (context) => {
  const origin = await listening(
    context,
    createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`<html>private-response-body for ${account}</html>`);
    }),
  );
  const failure = await requestFailure(
    HttpClientRequest.post(`${origin}${path}`).pipe(HttpClientRequest.bodyText('{"write":true}')),
  );
  const { line, report, all } = await reported(context, failure);

  assert.equal(report.error.code, "release.ANSWER_UNREADABLE");
  assert.match(
    line,
    new RegExp(`^Release stopped: HttpClientError DecodeError: HTTP 200: POST ${shape}\\n`),
  );
  assert.match(
    line,
    /fix: The service answered without an error status, so a write has most likely taken effect\./,
  );
  noLeak(all, [...leaks, "private-response-body"]);
});

test("collected failures are only as safe to rerun as the least safe of them", async (context) => {
  const unreachable = async () =>
    requestFailure(HttpClientRequest.get(`${await closedOrigin()}${path}`));
  const origin = await listening(
    context,
    createServer((socket) => socket.once("data", () => socket.destroy())),
  );
  const lost = await requestFailure(
    HttpClientRequest.post(`${origin}${path}`).pipe(HttpClientRequest.bodyText("{}")),
  );

  const mixed = await reported(
    context,
    new AggregateError([await unreachable(), lost], "Two requests failed"),
  );
  assert.equal(mixed.report.error.code, "release.OUTCOME_UNKNOWN");
  assert.match(mixed.line, /\n {2}failures collected: 2; the cause chain follows the first\n/);
  assert.doesNotMatch(mixed.line, /changed nothing/);

  const neverLeft = await reported(
    context,
    new AggregateError([await unreachable(), await unreachable()], "Two requests failed"),
  );
  assert.equal(neverLeft.report.error.code, "release.UNREACHABLE");
});

for (const [status, code, advice] of [
  [
    502,
    "release.SERVICE_BUSY",
    /fix: The service answered with a temporary failure\. Wait and rerun\./,
  ],
  [
    429,
    "release.SERVICE_BUSY",
    /fix: The service answered with a temporary failure\. Wait and rerun\./,
  ],
  [
    403,
    "release.REQUEST_REFUSED",
    /fix: The service refused the request\. Before rerunning, fix the request, its credentials or the state it conflicts with/,
  ],
] as const)
  test(`an HTTP ${status} answer is reported as what it is`, async (context) => {
    const origin = await listening(
      context,
      createHttpServer((_request, response) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(`{"errors":[{"message":"private-response-body for ${account}"}]}`);
      }),
    );
    const failure = await requestFailure(HttpClientRequest.get(`${origin}${path}`));
    const { line, report, all } = await reported(context, failure);

    assert.equal(report.error.code, code);
    assert.match(
      line,
      new RegExp(
        `^Release stopped: HttpClientError StatusCodeError: HTTP ${status}: GET ${shape}\\n`,
      ),
    );
    assert.match(line, new RegExp(`\\n {2}why: The service answered HTTP ${status}\\.`));
    assert.match(line, advice);
    noLeak(all, [...leaks, "private-response-body"]);
  });

test("a refusal keeps the reason and fix its author wrote, above the transport cause", async (context) => {
  const origin = await closedOrigin();
  const refusal = new LiveModuleUnavailable({
    script: "PoolWorker",
    why: "The live script's `main` module could not be read.",
    fix: "Do not run the class change; read the live script again.",
    cause: await requestFailure(HttpClientRequest.get(`${origin}${path}`)),
  });
  const { line, summary, report, all } = await reported(context, refusal);

  assert.equal(report.error.code, "LiveModuleUnavailable");
  assert.equal(report.error.why, "The live script's `main` module could not be read.");
  assert.equal(report.error.fix, "Do not run the class change; read the live script again.");
  assert.match(
    line,
    /\n {2}why: The live script's `main` module could not be read\.\n {2}fix: Do not run the class change; read the live script again\.\n {2}script: PoolWorker\n/,
  );
  assert.match(line, new RegExp(`\\n {2}cause 1: HttpClientError TransportError: GET ${shape}\\n`));
  assert.match(line, /\n {2}cause 3: Error ECONNREFUSED$/);
  assert.ok(summary.includes(line.replaceAll("```", "'''")));
  noLeak(all);
});

test("a refusal raised inside another error is still reported as the refusal", async (context) => {
  const refusal = new LiveModuleUnavailable({
    script: "PoolWorker",
    why: "The live script's `main` module could not be read.",
    fix: "Do not run the class change; read the live script again.",
  });
  const { line, report } = await reported(
    context,
    new Error("The deploy step failed", { cause: refusal }),
  );

  assert.equal(report.error.code, "LiveModuleUnavailable");
  assert.equal(
    line,
    [
      "Release stopped: LiveModuleUnavailable",
      "  why: The live script's `main` module could not be read.",
      "  fix: Do not run the class change; read the live script again.",
      "  raised inside: Error",
      "  script: PoolWorker",
    ].join("\n"),
  );
});

test("a refusal's evidence is printed exactly: digests, a commit and an operation id", async (context) => {
  const uploaded = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  const planned = "80a00f0b51c6d51dc228b0b2b1f4fb3a510da55c0aaef2a956d7c488180d68f9";
  const { line } = await reported(
    context,
    new WireRefused({
      resource: "PoolWorker",
      path: "/workers/scripts/{id}",
      value: `${uploaded} (expected ${planned})`,
      why: `The uploaded module's digest ${uploaded} is not the planned one.`,
      fix: "Plan again from commit 533199cfa3b565b9b7e14f69abae597f09828760.",
      detail: { operation: "123e4567-e89b-12d3-a456-426614174000", planned },
    }),
  );

  for (const exact of [
    `  value: ${uploaded} (expected ${planned})`,
    `  why: The uploaded module's digest ${uploaded} is not the planned one.`,
    "  fix: Plan again from commit 533199cfa3b565b9b7e14f69abae597f09828760.",
    `  detail: {"operation":"123e4567-e89b-12d3-a456-426614174000","planned":"${planned}"}`,
  ])
    assert.ok(line.split("\n").includes(exact), exact);
});

test("every violation of a refused plan is listed, with its reason and fix or the lack of one", async (context) => {
  const { line, summary, report } = await reported(
    context,
    new PlanRefused({
      violations: [
        {
          rule: "binding-removed",
          fqn: "PoolWorker",
          type: "Cloudflare.Worker",
          action: "update",
          change: ["bindings.PoolRuntimeBlue: present -> absent"],
          why: "A release never removes a Worker binding: the running code may still read it.",
          fix: "Restore the binding in the Worker's declaration.",
        },
        { rule: "binding-added", fqn: "Api", type: "Cloudflare.Worker", action: "update" },
      ],
    }),
  );

  assert.equal(report.error.message, "2 violations refused this step");
  assert.match(
    line,
    /\n {2}violation: binding-removed PoolWorker Cloudflare\.Worker update\n {4}change: bindings\.PoolRuntimeBlue: present -> absent\n {4}why: A release never removes a Worker binding: the running code may still read it\.\n {4}fix: Restore the binding in the Worker's declaration\.\n/,
  );
  assert.match(
    line,
    /\n {2}violation: binding-added Api Cloudflare\.Worker update\n {4}why: \(no reason given\)\n {4}fix: \(no fix given\)/,
  );
  assert.ok(summary.includes("violation: binding-added Api Cloudflare.Worker update"));
});

test("nothing a refusal carries can put private text or a command into the log", async (context) => {
  const cyclic: Record<string, unknown> = {
    body: `<html>error for ops@example.com at db.internal.example.com</html>`,
  };
  cyclic.self = cyclic;
  for (const detail of [
    { note: `owner jane@example.com from 10.0.0.5 token=${token}` },
    cyclic,
    10n,
  ]) {
    const { line, annotation, all, report } = await reported(
      context,
      new WireRefused({
        resource: `postgres://admin:${token}@db.internal.example.com:5432/prod`,
        path: "/Users/alice/work/basalt/secret.json",
        value: "kept 'quoted name'\n::error::spoofed",
        why: `Provider said: {"token":"${token}"} from api.Example.Com`,
        fix: "Ask ops@example.com.\n::stop-commands::x",
        link: `https://dash.cloudflare.com/${account}/workers?token=${token}`,
        // Shaped like a code, and still a credential.
        code: `K${"a1".repeat(20)}`,
        detail,
      }),
    );

    assert.equal(report.error.link, undefined);
    assert.equal(report.error.code, "WireRefused");
    assert.match(
      line,
      /\n {2}resource: \[url\]\n {2}path: ~\/work\/basalt\/secret\.json\n {2}value: kept 'quoted name' ::error::spoofed\n/,
    );
    assert.match(
      line,
      /\n {2}why: Provider said: \{"token":\[redacted\]\} from \[host\]\n {2}fix: Ask \[email\]\. ::stop-commands::x\n/,
    );
    // No printed line starts a workflow command, and the annotation is the only `::error`.
    assert.ok(line.split("\n").every((printed) => !/^\s*::|##\[/u.test(printed)));
    assert.equal(annotation.match(/::error/gu)?.length, 2);
    assert.ok(annotation.startsWith("::error title=Release stopped::Release stopped: "));
    noLeak(all, [
      ...leaks,
      "db.internal.example.com",
      "alice",
      "jane@example.com",
      "ops@example.com",
      "10.0.0.5",
      "api.Example.Com",
      "a1a1a1a1",
    ]);
  }
});

test("a documentation link is printed when it is only a link", async (context) => {
  const { line } = await reported(
    context,
    new WireRefused({
      resource: "PoolWorker",
      path: "/workers/scripts/{id}",
      value: "deleted_classes",
      why: "A release never deletes a class.",
      fix: "Do it by hand under its own approval.",
      link: "https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/#delete",
    }),
  );
  assert.match(
    line,
    /\n {2}link: https:\/\/developers\.cloudflare\.com\/durable-objects\/reference\/durable-objects-migrations\/#delete\n/,
  );
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
  const { line, annotation, summary, report, all } = await reported(
    context,
    new AggregateError(
      [new Error("Preview basalt cleanup failed", { cause: failure })],
      "Preview cleanup did not finish",
    ),
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
    /\n {4}--- stdout\n {4}Plan: 2 to update\n {4}--- stderr\n {4}PoolWorker \(Cloudflare\.Worker\) update failed\n {4}CloudflareHttpError: PUT \[url\] 400\n {6}code 10021: Script startup exceeded CPU time limit\n {6}Authorization: \[redacted\]$/,
  );
  assert.ok(annotation.includes("code 10021: Script startup exceeded CPU time limit"));
  assert.ok(
    summary.includes(
      "    CloudflareHttpError: PUT [url] 400\n      code 10021: Script startup exceeded CPU time limit",
    ),
  );
  noLeak(all, [token, account, "api.cloudflare.com"]);
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
  // Where it was raised, without the home directory it ran under.
  assert.match(line, /\n {2}at .*\(scripts\/failure-report\.test\.ts:\d+:\d+\)$/);
  assert.doesNotMatch(line, /\/(?:Users|home)\/|file:/);
  noLeak(line, ["preview.example.dev", "Jane Doe", "jane@example.com", token]);
});

test("an evlog error is reported with its own fields, and nothing printed reaches what it wrapped", async (context) => {
  const error = createError({
    code: "release.BACKUP_MISSING",
    message: "No backup covers this release",
    why: `The newest backup is older than the candidate; the provider said token=${token}.`,
    fix: "Run the backup step, then plan again.",
    link: "https://developers.cloudflare.com/workers/configuration/versions-and-deployments/",
    cause: new Error(`upstream said password=${token} at db.internal.example.com`),
  });
  const { line, report } = await reported(context, error);
  assert.match(
    line,
    /^Release stopped: No backup covers this release\n {2}code: release\.BACKUP_MISSING\n {2}why: The newest backup is older than the candidate; the provider said token=\[redacted\]\n {2}fix: Run the backup step, then plan again\.\n {2}link: https:\/\/developers\.cloudflare\.com\/workers\/configuration\/versions-and-deployments\/\n {2}cause 1: Error$/,
  );
  noLeak(
    JSON.stringify([
      String(report.error),
      report.error.toJSON(),
      report.error.cause,
      report.error.why,
    ]),
    [token, "db.internal.example.com"],
  );
});

test("a failure that cannot be read is still reported", async (context) => {
  const hostile = new Proxy(new Error("hidden"), {
    getPrototypeOf() {
      throw new Error("private-prototype");
    },
    ownKeys() {
      throw new Error("private-keys");
    },
  });
  const { line } = await reported(context, hostile);
  assert.match(line, /^Release stopped: /);
  assert.match(line, /\n {2}fix: /);
  noLeak(line, ["private-prototype", "private-keys"]);
});

test("the same transport failure is recognised when the command runs under Bun", () => {
  const module = fileURLToPath(new URL("./failure/report.ts", import.meta.url));
  const program = `
    import { createServer } from "node:net";
    import { reportFailure } from ${JSON.stringify(module)};
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    const failure = await fetch("http://127.0.0.1:" + port + ${JSON.stringify(path)}).then(() => undefined, (error) => error);
    const report = await reportFailure(new Error("read failed", { cause: failure }), { title: "Release stopped" });
    console.log(report.error.code);`;
  const result = spawnSync("bun", ["-e", program], {
    encoding: "utf8",
    timeout: 50_000,
    killSignal: "SIGKILL",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "release.UNREACHABLE");
  assert.match(
    result.stderr,
    /\n {2}fix: This request never left, so it changed nothing at the service\. Rerun/,
  );
  // Bun names the refusal on the fetch error itself, under either spelling.
  assert.match(result.stderr, /\n {2}cause 1: TypeError (?:ConnectionRefused|ECONNREFUSED): /);
  noLeak(result.stderr, ["127.0.0.1", account]);
});

test("structuredFailure gives the same report without printing", () => {
  const report = structuredFailure(new TypeError(`fetch failed for ${token}`), environment);
  assert.equal(report.error.code, "release.UNEXPECTED");
  assert.equal(report.error.message, "TypeError: fetch failed for [redacted]");
  assert.deepEqual(report.causes, []);

  // A code bug's message names the identifier at fault.
  const bug = structuredFailure(
    new TypeError("Cannot read properties of undefined (reading 'main')"),
    environment,
  );
  assert.equal(
    bug.error.message,
    "TypeError: Cannot read properties of undefined (reading 'main')",
  );

  // A failed command's exit status is not an HTTP status.
  const exited = structuredFailure(
    Object.assign(new Error("Command failed"), { status: 137, pid: 4242, spawnargs: ["sh"] }),
    environment,
  );
  assert.equal(exited.error.code, "release.UNEXPECTED");
  assert.doesNotMatch(String(exited.error.why), /HTTP/);
});
