import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { sentrySource } from "../../src/catalog/sentry.ts";

const sdk = await import("../../.upstream/packages/sdk/src/core.ts");
const { callTools, describeCatalog, executeProgram, executionProgress } =
  await import("../../.upstream/packages/mcp/src/implementation/execute.ts");
const { CallOutcome, DescribeResult, defaultMcpLimits } =
  await import("../../.upstream/packages/mcp/src/contracts/execute.ts");

type Backend = Parameters<typeof describeCatalog>[0];
type Program = ReturnType<typeof callTools>;

/** The title and description the served Sentry app gives its REST section. */
const sentryApiSection = () => {
  const index = sentrySource.files.find((file) => file.path === "index.ts")?.content ?? "";
  const declared = /title: "(Sentry API)",\s+description:\s+("(?:[^"\\]|\\.)*")/u.exec(index);
  assert.ok(declared, "the served Sentry app declares its REST section");
  return { title: declared[1]!, description: String(JSON.parse(declared[2]!)) };
};

const app = sdk.AppId.make("app_sentry");
const version = sdk.VersionId.make("dpl_sentry");
const account = sdk.AccountId.make("acc_sign_in");
const update = "tools.sentry.api.update_a_monitor";
const typo = "tools.sentry.mcp.update_monitor";
const listed = "tools.sentry.mcp.find_monitors";

/**
 * The catalog an account connected by Sentry sign-in is listed: Sentry's MCP tools, and the REST
 * section with its title and description but no tools, because the app mounts REST operations
 * only for personal-token accounts. `hidden` is the host's own reason for a tool it hides.
 */
const signedIn = (hidden?: string): Backend => {
  const section = sentryApiSection();
  const backend: Pick<Backend, "listApps" | "listAccounts" | "listTools"> = {
    listApps: () =>
      Effect.succeed([
        { id: app, name: "Sentry", slug: sdk.AppSlug.make("sentry"), activeVersion: version },
      ]),
    listAccounts: () =>
      Effect.succeed({
        sentry: {
          cardinality: "many",
          accounts: [{ id: account, label: "Sentry sign-in", description: null }],
        },
      }),
    listTools: () =>
      Effect.succeed({
        version,
        accounts: { app: {}, user: { sentry: [account] } },
        items: [
          {
            app,
            version,
            name: sdk.ToolName.make("mcp.find_monitors"),
            router: "mcp",
            description: "Find cron monitors in an organization.",
            inputSchema: { type: "object", properties: {} },
            readOnly: true,
          },
        ],
        routers: [
          { path: "", title: "Sentry" },
          { path: "mcp", title: "Sentry MCP" },
          { path: "api", ...section },
        ],
      }),
  };
  // Describe, call and a program that calls or describes read only these operations.
  return {
    ...backend,
    ...(hidden === undefined ? {} : { unavailableToolReason: () => Effect.succeed(hidden) }),
  } as Backend;
};

const run = (program: Program, backend: Backend) =>
  Effect.runPromise(program(backend, defaultMcpLimits, Effect.never, executionProgress(undefined)));

/** Asserts the answer names the section and gives its description, as the agent reads it. */
const explains = (answer = "") => {
  const section = sentryApiSection();
  assert.ok(answer.includes(section.title), `names the section: ${answer}`);
  assert.ok(answer.includes(section.description), `gives the section's description: ${answer}`);
};

test("describing a tool in Sentry's REST section answers with what the section needs", async () => {
  const described = await Effect.runPromise(
    describeCatalog(signedIn(), { paths: [update, listed, typo] }),
  );
  assert.deepEqual(
    described.items.map((item) => item.path),
    [listed],
  );
  const [inSection, unknown] = described.missing;
  assert.equal(inSection?.path, update);
  explains(inSection?.reason);
  // A section that lists tools is unchanged: an unknown path in it has only its closest paths.
  assert.deepEqual(unknown, { path: typo, matches: [listed] });
});

test("calling a tool in Sentry's REST section answers with what the section needs", async () => {
  const result = await run(
    callTools({
      calls: [
        { path: update, input: {} },
        { path: typo, input: {} },
      ],
    }),
    signedIn(),
  );
  assert.ok(result.execution.ok);
  const [inSection, unknown] = await Effect.runPromise(
    Schema.decodeUnknownEffect(Schema.Array(CallOutcome))(result.execution.value),
  );
  assert.ok(inSection?.ok === false && unknown?.ok === false);
  assert.ok(!inSection.error.message.startsWith("No tool at"), inSection.error.message);
  explains(inSection.error.message);
  // A section that lists tools is unchanged: an unknown path in it is still an unknown tool.
  assert.equal(unknown.error.kind, "UnknownTool");
  assert.equal(unknown.error.message, `No tool at ${typo}. Use search to find exact paths.`);
  assert.deepEqual(unknown.matches, [listed]);
});

test("a program that calls or describes a tool in Sentry's REST section is told the same", async () => {
  const called = await run(executeProgram(`return await ${update}({});`), signedIn());
  assert.ok(!called.execution.ok);
  explains(called.execution.error.message);
  const described = await run(
    executeProgram(`return await tools.search.describe({ paths: [${JSON.stringify(update)}] });`),
    signedIn(),
  );
  assert.ok(described.execution.ok, JSON.stringify(described.execution));
  const { missing } = await Effect.runPromise(
    Schema.decodeUnknownEffect(DescribeResult)(described.execution.value),
  );
  assert.equal(missing[0]?.path, update);
  explains(missing[0]?.reason);
});

test("the host's reason for a tool it hides comes before the section's", async () => {
  const hidden = "This tool is switched off for this app.";
  const described = await Effect.runPromise(describeCatalog(signedIn(hidden), { paths: [update] }));
  assert.equal(described.missing[0]?.reason, hidden);
  const result = await run(callTools({ calls: { path: update, input: {} } }), signedIn(hidden));
  assert.ok(result.execution.ok);
  const outcome = await Effect.runPromise(
    Schema.decodeUnknownEffect(CallOutcome)(result.execution.value),
  );
  assert.ok(outcome.ok === false);
  assert.equal(outcome.error.message, hidden);
});
