import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { inspect } from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandError,
  CommandExecutor,
  CommandExecutorLive,
  CommandTimedOut,
  OutputNotFound,
  UnexpectedExit,
} from "alchemy/Command/Command";
import { Cause, Data, Effect, Exit, Layer } from "effect";
import { BadArgument, SystemError } from "effect/PlatformError";
import { captureChild, ChildProcessFailure } from "./failure/child.ts";
import { reportFailure, structuredFailure } from "./failure/report.ts";

const token = "cf-token-0123456789abcdef";
const environment = { CLOUDFLARE_API_TOKEN: token };

class BudgetCheckFailed extends Data.TaggedError("BudgetCheckFailed")<{
  readonly why: string;
  readonly fix: string;
  readonly cause?: unknown;
}> {}

/** What a person sees: the lines on the error output and the step summary file. */
async function reported(context: TestContext, error: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "basalt-failure-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const summaryPath = join(directory, "summary.md");
  const lines: string[] = [];
  const report = await reportFailure(error, {
    title: "Release stopped",
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
const firstLine = async (context: TestContext, error: unknown) =>
  (await reported(context, error)).line.split("\n")[0];
const noLeak = (text: string, values: readonly string[]) => {
  for (const leak of values) assert.ok(!text.includes(leak), leak);
};
const failed = (command: string, args: readonly string[], options = {}) =>
  captureChild(command, args, { env: { ...environment, PATH: process.env.PATH }, ...options }).then(
    () => assert.fail("The command was expected to fail"),
    (error: unknown) => error,
  );

// A check that prints its failure through Effect's default logger, which writes to standard output,
// writes nothing to standard error and exits 1.
const budgetFailure = `timestamp=2026-11-19T00:22:03.412Z level=ERROR fiber=#1 cause="PoolBudgetFailed: the runtime login holds 31 of 25 connections on postgres://admin:${token}@db.internal.example.com:5432/pool"`;
const budgetScript = `console.log(${JSON.stringify(budgetFailure)}); process.exit(1);`;
const silent = () =>
  new CommandError({
    command: "node verify-database-budget.ts",
    reason: new UnexpectedExit({ exitCode: 1, stderr: "" }),
  });
const silentWhy =
  "Alchemy ran this command for a resource. It printed nothing on standard error, and Alchemy's error keeps no standard output, so what the command said about its failure is not in this report.";
const alone =
  "Run the command alone to see what it prints, fix what that names, then rerun this step.";
// A write whose connection broke after the request may have been sent.
const lostWrite = () =>
  Object.assign(
    new Error("The upload failed", {
      cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    }),
    { request: { method: "POST", url: "https://api.example.com/client/v4/accounts/abc/workers" } },
  );

test("a command that explains its failure on standard output only is reported with its exit and that output", async (context) => {
  const failure = await failed(process.execPath, ["-e", budgetScript]);
  const { line, annotation, summary, all } = await reported(context, failure);

  assert.equal(
    line,
    [
      "Release stopped: node failed with exit 1",
      "  code: release.CHILD_FAILED",
      "  why: A command this step ran did not succeed. Its last output lines are below.",
      "  fix: Fix what the output names and rerun this step.",
      "  last output lines, credentials removed:",
      "    --- stdout",
      '    timestamp=2026-11-19T00:22:03.412Z level=ERROR fiber=#1 cause="PoolBudgetFailed: the runtime login holds 31 of 25 connections on [url]"',
    ].join("\n"),
  );
  assert.ok(annotation.includes("PoolBudgetFailed: the runtime login holds 31 of 25 connections"));
  assert.ok(summary.includes("PoolBudgetFailed: the runtime login holds 31 of 25 connections"));
  noLeak(all, [token, "db.internal.example.com", "admin:"]);
});

test("a command that fails without a word, or never starts, is told as that", async (context) => {
  const wordless = await reported(
    context,
    await failed(process.execPath, ["-e", "process.exit(2)"]),
  );
  assert.equal(
    wordless.line,
    [
      "Release stopped: node failed with exit 2",
      "  code: release.CHILD_FAILED",
      "  why: A command this step ran did not succeed and printed nothing.",
      `  fix: ${alone}`,
    ].join("\n"),
  );

  const missing = await reported(context, await failed("basalt-no-such-command", []));
  assert.equal(
    missing.line,
    [
      "Release stopped: basalt-no-such-command could not start (ENOENT)",
      "  code: release.CHILD_FAILED",
      "  why: The command never ran, so it changed nothing.",
      "  fix: Check that the program is installed and on the path and that its working directory exists, then rerun this step.",
    ].join("\n"),
  );
});

test("a command that floods its output and ignores the request to stop is stopped all the same", async (context) => {
  const failure = await failed(
    process.execPath,
    ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => console.log("x".repeat(4096)), 1);'],
    { maximumOutputBytes: 64 * 1024 },
  );
  assert.ok(failure instanceof ChildProcessFailure);
  assert.deepEqual([failure.report.stopped, failure.report.signal], ["output-limit", "SIGKILL"]);
  const { line } = await reported(context, failure);
  assert.match(
    line,
    /^Release stopped: node printed more than its output limit and was stopped\n {2}code: release\.CHILD_FAILED\n {2}why: The command printed more than this step keeps and was stopped part-way\.\n {2}fix: Find why it prints so much, starting at its last lines below\. It was stopped part-way, so check what it had already changed before rerunning this step\.\n/,
  );
});

/** Alchemy's own command runner, the one `Command.Exec` uses, running a real command that fails. */
async function stackCommandFailure(context: TestContext, script: string) {
  const directory = mkdtempSync(join(tmpdir(), "basalt-stack-command-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "verify-database-budget.mjs"), script);
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const { run } = yield* CommandExecutor;
      return yield* run(
        // The command inherits this process's environment; a preload could print on its own.
        {
          command: "node verify-database-budget.mjs",
          cwd: directory,
          env: { NODE_OPTIONS: "" },
        },
        { emit: () => Effect.void, done: () => Effect.void, note: () => Effect.void },
      );
    }).pipe(Effect.provide(CommandExecutorLive().pipe(Layer.provide(NodeServices.layer)))),
  );
  assert.ok(Exit.isFailure(exit));
  return exit.cause;
}

test("a command Alchemy ran that explained itself on standard output only is reported with its name, its exit and how to see the rest", async (context) => {
  const cause = await stackCommandFailure(context, budgetScript);
  const failure = Cause.squash(cause);
  // What Alchemy 2.0.0-beta.80 raises for it: the exit code and an empty standard error. If this
  // fails, Alchemy keeps more than it did: print that too, and take the gap out of the report.
  assert.ok(failure instanceof CommandError);
  assert.ok(failure.reason instanceof UnexpectedExit);
  assert.deepEqual([failure.reason.exitCode, failure.reason.stderr], [1, ""]);
  assert.ok(!inspect(failure, { depth: 8, showHidden: true }).includes("PoolBudgetFailed"));

  const { line, annotation, summary } = await reported(context, failure);
  assert.equal(
    line,
    [
      "Release stopped: node verify-database-budget.mjs failed with exit 1",
      "  code: release.STACK_COMMAND_FAILED",
      `  why: ${silentWhy}`,
      `  fix: ${alone}`,
    ].join("\n"),
  );
  assert.equal(
    annotation,
    `::error title=Release stopped::${line.replaceAll("%", "%25").replaceAll("\n", "%0A")}`,
  );
  assert.equal(summary, `## Release stopped\n\n\`\`\`text\n${line}\n\`\`\`\n`);

  // Handed over whole, as Effect's cause instead of the failure in it, it is still found.
  const whole = await reported(context, cause);
  assert.equal(whole.report.error.code, "release.STACK_COMMAND_FAILED");
  assert.equal(whole.report.error.message, "node verify-database-budget.mjs failed with exit 1");
});

test("a command Alchemy ran is reported with its standard error, cleaned, wherever its error sits", async (context) => {
  const stderr = [
    "Migration step (attempt 1): plan the auth schema",
    `driver: password=${token} relation="pool_accounts" at db.internal.example.com`,
    `Authorization: Bearer ${token}`,
  ].join("\n");
  const loud = new CommandError({
    command: `node src/migrate.ts --admin-url postgres://admin:${token}@db.internal.example.com/pool`,
    reason: new UnexpectedExit({ exitCode: 3, stderr }),
  });
  const kept = [
    "    --- stderr",
    "    Migration step (attempt 1): plan the auth schema",
    '    driver: password=[redacted] relation="pool_accounts" at db.internal.example.com',
    "    Authorization: [redacted]",
  ];

  const direct = await reported(context, loud);
  assert.equal(
    direct.line,
    [
      "Release stopped: node migrate.ts failed with exit 3",
      "  code: release.STACK_COMMAND_FAILED",
      "  why: Alchemy ran this command for a resource. Its error keeps the command's standard error, whose last lines are below, and none of its standard output.",
      "  fix: Fix what those lines name and rerun this step. If they do not explain the failure, run the command alone to see what it prints on standard output.",
      "  last output lines, credentials removed:",
      ...kept,
    ].join("\n"),
  );
  noLeak(direct.all, [token, "admin:"]);

  // Raised inside the entry's own error, the command is still the subject.
  const wrapped = await reported(context, new Error("The apply failed", { cause: loud }));
  assert.equal(wrapped.report.error.code, "release.STACK_COMMAND_FAILED");
  assert.match(wrapped.line, /^Release stopped: node migrate\.ts failed with exit 3\n/);
  assert.match(wrapped.line, /\n {2}cause 1: CommandError\n/);
  assert.ok(wrapped.line.endsWith(kept.join("\n")));

  // Under a refusal the refusal's author speaks, and the command and what is kept of it follow.
  const refused = await reported(
    context,
    new BudgetCheckFailed({
      why: "The database budget could not be verified.",
      fix: "Do not release until the budget check passes.",
      cause: silent(),
    }),
  );
  assert.equal(
    refused.line,
    [
      "Release stopped: BudgetCheckFailed",
      "  why: The database budget could not be verified.",
      "  fix: Do not release until the budget check passes.",
      "  cause 1: CommandError",
      "  last output lines, credentials removed:",
      `    --- node verify-database-budget.ts failed with exit 1: ${silentWhy} ${alone}`,
    ].join("\n"),
  );
});

test("a command Alchemy stopped, refused or could not run is told as that, never as an empty error", async (context) => {
  const timedOut = await reported(
    context,
    new CommandError({
      command: "node verify-database-budget.ts --ready",
      reason: new CommandTimedOut({ timeout: "3m 5s" }),
    }),
  );
  assert.equal(
    timedOut.line,
    [
      "Release stopped: node verify-database-budget.ts timed out after 3m 5s",
      "  code: release.STACK_COMMAND_FAILED",
      "  why: Alchemy ran this command for a resource and stopped it at its time limit. Its error keeps none of the command's output.",
      "  fix: The command was stopped part-way, so check what it had already changed. Run it alone to see where its time goes, then rerun this step.",
    ].join("\n"),
  );
  // Only a duration is printed as one.
  assert.equal(
    await firstLine(
      context,
      new CommandError({
        command: "node src/migrate.ts",
        reason: new CommandTimedOut({ timeout: `after ${token}` }),
      }),
    ),
    "Release stopped: node migrate.ts timed out",
  );

  const lost = await reported(
    context,
    new CommandError({
      command: "basalt-no-such-command --check",
      reason: new SystemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        pathOrDescriptor: "/Users/alice/bin/basalt-no-such-command",
      }),
    }),
  );
  assert.equal(
    lost.line,
    [
      "Release stopped: basalt-no-such-command could not be run to its end (NotFound)",
      "  code: release.STACK_COMMAND_FAILED",
      "  why: Alchemy could not start this command, or lost it while it ran. Its error keeps none of the command's output.",
      "  fix: Check that the program is installed and on the path and that its working directory exists. If it had started, check what it changed before rerunning this step.",
    ].join("\n"),
  );

  const refused = await reported(
    context,
    new CommandError({
      command: "",
      reason: new BadArgument({
        module: "Command",
        method: "parseCommand",
        description: "Command is empty",
      }),
    }),
  );
  assert.equal(
    refused.line,
    [
      "Release stopped: A command was refused as it was given",
      "  code: release.STACK_COMMAND_FAILED",
      "  why: It was refused before it ran: Command is empty.",
      "  fix: Fix the resource's command, working directory or time limit, then rerun this step.",
    ].join("\n"),
  );

  const unbuilt = await reported(
    context,
    new CommandError({
      command: "bun run build",
      reason: new OutputNotFound({ outdir: "/Users/alice/work/site/dist" }),
    }),
  );
  assert.equal(
    unbuilt.line,
    [
      "Release stopped: bun run build ended without its declared output",
      "  code: release.STACK_COMMAND_FAILED",
      "  why: Alchemy ran this command for a resource, and the path the resource declares as its output does not exist afterwards.",
      "  fix: Make the command write that path, or correct the resource's declared output, then rerun this step.",
    ].join("\n"),
  );
  noLeak(`${lost.all}${unbuilt.all}`, ["alice"]);

  // A reason Alchemy does not have today, and an exit that is no number, still name the command.
  assert.equal(
    await firstLine(context, {
      _tag: "CommandError",
      command: "node x.ts",
      reason: { _tag: token },
    }),
    "Release stopped: node x.ts did not succeed",
  );
  assert.equal(
    await firstLine(
      context,
      new CommandError({ command: "", reason: new UnexpectedExit({ exitCode: 1, stderr: "" }) }),
    ),
    "Release stopped: A command failed with exit 1",
  );
  // Another library's error of the same name is not read as a command.
  const other = await reported(
    context,
    Object.assign(new Error("ERR unknown command"), { _tag: "CommandError" }),
  );
  assert.equal(other.report.error.code, "release.UNEXPECTED");
});

test("a command Alchemy ran is named by its program and what it runs, never by its arguments", async (context) => {
  const named = async (command: string) =>
    firstLine(
      context,
      new CommandError({ command, reason: new UnexpectedExit({ exitCode: 1, stderr: "" }) }),
    );
  // Arguments can carry a value no rule knows to be a credential, so the first flag or value ends
  // the name.
  for (const [command, name] of [
    ["bun run build", "bun run build"],
    [
      "node /Users/alice/work/scripts/verify-database-budget.ts --ready",
      "node verify-database-budget.ts",
    ],
    ["curl -u admin:made-up-pass https://api.example.com/v4/x", "curl"],
    ["psql --key made-up-key-value postgres", "psql"],
    ["deploy \\\n  --password \\\n  made-up-pass", "deploy"],
    ["PGPASSWORD=made-up-pass PGUSER=admin psql -c 'select 1'", "psql"],
    [`sh -c "${"echo step; ".repeat(200)}"`, "sh"],
  ])
    assert.equal(await named(command), `Release stopped: ${name} failed with exit 1`, command);

  const spoofed = await reported(
    context,
    new CommandError({
      command: "::error::spoofed",
      reason: new UnexpectedExit({ exitCode: 2, stderr: "::stop-commands::x\n##[error]y" }),
    }),
  );
  assert.ok(
    spoofed.line.split("\n").every((printed) => !/^\s*::|##\[/u.test(printed)),
    spoofed.line,
  );
  noLeak(spoofed.all, ["::stop-commands", "##[error]"]);

  // A credential that spans lines goes whole, and line by line where a window cut its start off.
  const end = Array.from({ length: 12 }, (_, index) => `made-up-key-line-${index}`).join("\n");
  const key = `made-up-key-start\n${end}`;
  const keyed = structuredFailure(
    new CommandError({
      command: `sh -c 'echo "${key}" | install-key'`,
      reason: new UnexpectedExit({
        exitCode: 1,
        stderr: `${"x".repeat(70_000)}\ncould not read\n${end}\n${"later line\n".repeat(20)}`,
      }),
    }),
    { DEPLOY_KEY: key },
  );
  assert.equal(keyed.error.message, "sh failed with exit 1");
  assert.match(
    keyed.tail!,
    /^--- stderr\n\[truncated\]\ncould not read\n(?:\[redacted\]\n){12}later line\n/,
  );
  noLeak(inspect(keyed, { depth: 8 }), ["made-up-key"]);

  // Alchemy keeps all of a command's standard error; the report keeps its end.
  const flood = structuredFailure(
    new CommandError({
      command: "node flood.mjs",
      reason: new UnexpectedExit({
        exitCode: 1,
        stderr: `${"filler line\n".repeat(200_000)}the last line`,
      }),
    }),
    environment,
  );
  const kept = flood.tail!.split("\n");
  assert.equal(kept.length, 61);
  assert.deepEqual([kept[0], kept.at(-1)], ["--- stderr", "the last line"]);
});

test("commands among collected failures are each named, with what is kept of each", async (context) => {
  const loud = new CommandError({
    command: "node src/migrate.ts",
    reason: new UnexpectedExit({ exitCode: 3, stderr: "lock timeout (55P03)" }),
  });
  const { line } = await reported(
    context,
    new AggregateError([silent(), loud], "The apply failed"),
  );

  assert.equal(
    line,
    [
      "Release stopped: node verify-database-budget.ts failed with exit 1",
      "  code: release.STACK_COMMAND_FAILED",
      `  why: ${silentWhy}`,
      `  fix: ${alone}`,
      "  failures collected: 2; the cause chain follows the first",
      "  failure 1: node verify-database-budget.ts failed with exit 1",
      "  failure 2: node migrate.ts failed with exit 3",
      "  cause 1: CommandError",
      "  last output lines, credentials removed:",
      "    --- node verify-database-budget.ts failed with exit 1",
      "    --- node migrate.ts failed with exit 3: Fix what those lines name and rerun this step. If they do not explain the failure, run the command alone to see what it prints on standard output.",
      "    --- stderr",
      "    lock timeout (55P03)",
    ].join("\n"),
  );
});

test("a failed command beside a write that may have landed does not turn the advice into a rerun", async (context) => {
  const ours = await failed(process.execPath, [
    "-e",
    'console.error("bucket not empty"); process.exit(1)',
  ]);
  for (const command of [silent(), ours]) {
    const { line, report } = await reported(
      context,
      new AggregateError(
        [new Error("The cleanup failed", { cause: command }), lostWrite()],
        "The step did not finish",
      ),
    );
    assert.equal(report.error.code, "release.OUTCOME_UNKNOWN", line);
    assert.match(
      line,
      /\n {2}fix: The request may have reached the service\. A read can be rerun\. Before rerunning a write, check whether it took effect\.\n/,
    );
    const [advice, kept] = line.split("\n  last output lines, credentials removed:\n");
    assert.doesNotMatch(advice!, /rerun this step/);
    // The command is still named, with its own fix, above what is kept of its output.
    assert.match(kept!, /^ {4}--- node (?:\S+ )?failed with exit 1: .*rerun this step\./);
  }
  assert.match(
    (await reported(context, new AggregateError([ours, lostWrite()]))).line,
    /\n {4}--- node failed with exit 1: Fix what the output names and rerun this step\.\n {4}--- stderr\n {4}bucket not empty$/,
  );
});

test("a command stopped part-way keeps its warning beside a request that was never sent or refused", async (context) => {
  const migration = new ChildProcessFailure({
    command: "node",
    exitCode: null,
    signal: "SIGTERM",
    stopped: "output-limit",
    tail: "--- stdout\nmigrated 4000 of 9000 rows",
  });
  const neverSent = Object.assign(new Error("The call was not made"), {
    request: { method: "POST", url: "https://api.example.com/client/v4/accounts/1/workers" },
    cause: Object.assign(new TypeError("bad argument"), { code: "ERR_INVALID_ARG_TYPE" }),
  });
  const migrating = await reported(context, new AggregateError([neverSent, migration]));
  assert.equal(migrating.report.error.code, "release.CHILD_FAILED", migrating.line);
  assert.match(migrating.line, /\n {2}fix: .*check what it had already changed before rerunning/);

  const refused = Object.assign(new Error("refused"), {
    _tag: "HttpClientError",
    reason: {
      _tag: "StatusCodeError",
      response: { status: 400 },
      request: { method: "POST", url: "https://api.example.com/client/v4/accounts/1/workers" },
    },
  });
  const slow = new CommandError({
    command: "node migrate.ts",
    reason: new CommandTimedOut({ timeout: "5m" }),
  });
  const timing = await reported(context, new AggregateError([refused, slow]));
  assert.equal(timing.report.error.code, "release.STACK_COMMAND_FAILED", timing.line);
  assert.match(
    timing.line,
    /\n {2}fix: The command was stopped part-way, so check what it had already changed\./,
  );
});

test("a stdout reason is kept when the command also floods its standard error", async (context) => {
  const failure = await failed(process.execPath, [
    "-e",
    'console.log("BUDGET FAILED: 31 of 25 connections"); for (let i = 0; i < 80; i++) console.error(`warn: progress ${i}`); process.exit(1)',
  ]);
  const { line } = await reported(context, failure);
  assert.match(line, /\n {4}--- stdout\n {4}BUDGET FAILED: 31 of 25 connections\n {4}--- stderr\n/);
  assert.match(line, /\n {4}warn: progress 79$/);
});

test("collected failures are named by what each holds, and an unreadable one costs nothing else", async (context) => {
  const loud = new CommandError({
    command: "node migrate.ts",
    reason: new UnexpectedExit({ exitCode: 3, stderr: "lock timeout (55P03)" }),
  });
  // Effect wraps each failure of a cause in a `Fail`; the report names what is inside.
  const { line } = await reported(context, Cause.combine(Cause.fail(silent()), Cause.fail(loud)));
  assert.match(
    line,
    /\n {2}failure 1: node verify-database-budget\.ts failed with exit 1\n {2}failure 2: node migrate\.ts failed with exit 3\n/,
  );

  const hostile = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("private-trap");
      },
      get() {
        throw new Error("private-trap");
      },
    },
  );
  const beside = await reported(context, new AggregateError([silent(), hostile], "two"));
  assert.equal(beside.report.error.code, "release.STACK_COMMAND_FAILED", beside.line);
  const wrapped = await reported(
    context,
    new Error("Preview deploy failed: budget 31 of 25", { cause: hostile }),
  );
  assert.match(wrapped.line, /^Release stopped: Error: Preview deploy failed: budget 31 of 25\n/);
  noLeak(`${beside.all}${wrapped.all}`, ["private-trap"]);
});
