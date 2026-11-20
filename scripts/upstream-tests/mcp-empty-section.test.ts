import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { sentrySource } from "../../src/catalog/sentry.ts";

const sdk = await import("../../.upstream/packages/sdk/src/core.ts");
const { callTools, describeCatalog, executionProgress } =
  await import("../../.upstream/packages/mcp/src/implementation/execute.ts");
const { CallOutcome, defaultMcpLimits } =
  await import("../../.upstream/packages/mcp/src/contracts/execute.ts");

type Backend = Parameters<typeof describeCatalog>[0];

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

/**
 * The catalog an account connected by Sentry sign-in is listed: Sentry's MCP tools, and the REST
 * section with its title and description but no tools, because the app mounts REST operations
 * only for personal-token accounts.
 */
const signedIn = (): Backend => {
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
  // Describe and call read only the three operations above.
  return backend as Backend;
};

test("describing a tool in Sentry's REST section answers with what the section needs", async () => {
  const section = sentryApiSection();
  const described = await Effect.runPromise(
    describeCatalog(signedIn(), {
      paths: [
        "tools.sentry.api.update_a_monitor",
        "tools.sentry.mcp.find_monitors",
        "tools.sentry.mcp.update_monitor",
      ],
    }),
  );
  assert.deepEqual(
    described.items.map((item) => item.path),
    ["tools.sentry.mcp.find_monitors"],
  );
  const [update, typo] = described.missing;
  assert.ok(update && typo);
  assert.equal(update.path, "tools.sentry.api.update_a_monitor");
  assert.ok(update.reason?.includes(section.title), "names the section");
  assert.ok(update.reason.includes(section.description), "gives the section's description");
  // A section that lists tools is unchanged: an unknown path in it has only its closest paths.
  assert.deepEqual(typo, {
    path: "tools.sentry.mcp.update_monitor",
    matches: ["tools.sentry.mcp.find_monitors"],
  });
});

test("calling a tool in Sentry's REST section answers with what the section needs", async () => {
  const section = sentryApiSection();
  const result = await Effect.runPromise(
    callTools({
      calls: [
        { path: "tools.sentry.api.update_a_monitor", input: {} },
        { path: "tools.sentry.mcp.update_monitor", input: {} },
      ],
    })(signedIn(), defaultMcpLimits, Effect.never, executionProgress()),
  );
  assert.ok(result.execution.ok);
  const [update, typo] = Schema.decodeUnknownSync(Schema.Array(CallOutcome))(
    result.execution.value,
  );
  assert.ok(update?.ok === false && typo?.ok === false);
  assert.ok(!update.error.message.startsWith("No tool at"), update.error.message);
  assert.ok(update.error.message.includes(section.title), "names the section");
  assert.ok(update.error.message.includes(section.description), "gives the description");
  // A section that lists tools is unchanged: an unknown path in it is still an unknown tool.
  assert.equal(typo.error.kind, "UnknownTool");
  assert.equal(
    typo.error.message,
    "No tool at tools.sentry.mcp.update_monitor. Use search to find exact paths.",
  );
  assert.deepEqual(typo.matches, ["tools.sentry.mcp.find_monitors"]);
});
