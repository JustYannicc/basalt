// Basalt's own alchemy.run.ts is judged line by line: only edits that name the stack, its state
// store, the stage, the database or a Workflow host's identity count.
import assert from "node:assert/strict";
import test from "node:test";
import { classifySnapshots } from "./classify.ts";
import { pins, sha } from "./fixtures.test-helpers.ts";

// Shaped like the root stack, trimmed to the parts the cases edit.
const stack = `import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Planetscale from "alchemy/Planetscale";
import { Stage } from "alchemy/Stage";
import { Config, Effect } from "effect";
import { telemetryBindings } from "./src/telemetry/deployment.ts";
import { retain } from "alchemy/RemovalPolicy";
import { adopt } from "alchemy/AdoptPolicy";
import { brand, deployment } from "./brand.ts";
import { stackState } from "./.upstream/apps/hosted/cloud/src/infrastructure/state.ts";

export default Alchemy.Stack(
  "basalt",
  { providers: cloudProviders, state: stackState },
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const stage = yield* Stage;
    const previewNumber = /^test-pr-([1-9][0-9]*)$/.exec(stage)?.[1];
    const preview = previewNumber === undefined ? undefined : { number: previewNumber };
    const zoneName = preview?.domain ?? brand.zone;
    const host = preview === undefined ? brand.host : \`app.pr-\${preview.number}.\${preview.domain}\`;
    const zone = yield* Cloudflare.Zone.findZoneByName({ accountId, name: zoneName }).pipe(
      Effect.orDie,
    );
    if (!zone) return yield* Effect.die(new Error("Cloudflare zone for this stage is missing"));
    const emailReady = preview === undefined
      ? (yield* Cloudflare.Email.SendingSubdomain("AuthEmailDomain", {
          zoneId: zone.id,
          name: brand.emailDomain,
        })).enabled
      : false;
    const role = yield* Planetscale.PostgresRole("RuntimeRole", {
      database: cluster,
      branch: "main",
      ttl: undefined,
      description: "Runtime access",
      inheritedRoles: ["pg_read_all_data", "pg_write_all_data"],
    });
    const router = yield* Cloudflare.Worker("Router", {
      main: new URL("./src/router.ts", import.meta.url).pathname,
      assets: fileURLToPath(new URL("./public/", import.meta.url)),
      domain: host,
      workersDev: false,
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
      name: "basalt-router",
    });
    return { url: router.url, emailReady };
  }),
);
`;

function classifyStack(after: string, before = stack) {
  return classifySnapshots({
    baseGitCommit: sha("1"), candidateGitCommit: sha("2"), basePins: pins(), candidatePins: pins(),
    localChangedPaths: ["alchemy.run.ts"],
    localContents: { "alchemy.run.ts": { base: before, candidate: after } },
  });
}

const replaced = (from: string, to: string) => {
  assert.ok(stack.includes(from), from);
  return stack.replace(from, to);
};

test("a production zone ruleset added to the stack is clear", () => {
  // The shape of the browser integrity check exemption.
  const ruleset = replaced(
    "    if (!zone) return yield* Effect.die(new Error(\"Cloudflare zone for this stage is missing\"));\n",
    `    if (!zone) return yield* Effect.die(new Error("Cloudflare zone for this stage is missing"));
    if (preview === undefined) {
      // API, MCP and CLI clients are not browsers, so Browser Integrity Check (1010) would block them.
      // The zone keeps it for everything else. This resource owns the zone's whole configuration-rules
      // phase, which is why previews, sharing one zone, don't create it. Ruleset reads only \`zoneId\`.
      yield* Cloudflare.Ruleset.Ruleset("ApiBrowserCheckExemption", {
        zone: { zoneId: zone.id } as unknown as Cloudflare.Zone.Zone,
        phase: "http_config_settings",
        description: "Basalt API paths skip Browser Integrity Check",
        rules: [{
          action: "set_config",
          actionParameters: { bic: false },
          expression: apiPathsExpression(host),
          description: "Non-browser API paths on the app host",
          enabled: true,
        }],
      });
    }
`,
  ).replace("import { Config, Effect } from \"effect\";\n", "import { Config, Effect } from \"effect\";\nimport { apiPathsExpression } from \"./src/browser-check.ts\";\n");
  const report = classifyStack(ruleset);
  assert.equal(report.databaseChanged, false, JSON.stringify(report.evidence.database));
  assert.equal(report.workflowChanged, false, JSON.stringify(report.evidence.workflow));
});

test("the stack name and its state store are database and Workflow identity", () => {
  for (const after of [
    replaced("  \"basalt\",\n", "  \"basalt-v2\",\n"),
    replaced("state: stackState }", "state: Alchemy.localState() }"),
  ]) {
    const report = classifyStack(after);
    assert.equal(report.databaseChanged, true);
    assert.equal(report.workflowChanged, true);
    assert.equal(report.evidence.database.sources[0]?.name, "Basalt stack");
  }
});

test("a database role prop far from its call is database-changing", () => {
  const report = classifyStack(replaced("      inheritedRoles: [\"pg_read_all_data\", \"pg_write_all_data\"],", "      inheritedRoles: [\"pg_read_all_data\"],"));
  assert.equal(report.databaseChanged, true);
  assert.equal(report.workflowChanged, false);
});

test("a Worker name is Workflow identity; its other props are not", () => {
  const renamed = classifyStack(replaced("      name: \"basalt-router\",", "      name: \"basalt-edge\","));
  assert.equal(renamed.workflowChanged, true);
  const compatibility = classifyStack(replaced("      workersDev: false,\n      compatibility", "      workersDev: true,\n      compatibility"));
  assert.equal(compatibility.workflowChanged, false);
  assert.equal(compatibility.databaseChanged, false);
});

test("what carries the upstream stack, the pool and adoption into this one is identity", () => {
  const withCarriers = replaced("    return { url: router.url, emailReady };\n  }),\n);",
    "    const api = yield* Api;\n    const pool = yield* poolWorker;\n    return { url: router.url, emailReady };\n  }).pipe(adopt(true), Effect.provide(cloudWorkers)),\n);");
  const from = (a: string, b: string) => {
    assert.ok(withCarriers.includes(a), a);
    return classifySnapshots({
      baseGitCommit: sha("1"), candidateGitCommit: sha("2"), basePins: pins(), candidatePins: pins(),
      localChangedPaths: ["alchemy.run.ts"],
      localContents: { "alchemy.run.ts": { base: withCarriers, candidate: withCarriers.replace(a, b) } },
    });
  };
  for (const report of [
    from("    const pool = yield* poolWorker;\n", ""),
    from("adopt(true)", "adopt(false)"),
    from(", Effect.provide(cloudWorkers)", ""),
    from("import { stackState } from \"./.upstream/apps/hosted/cloud/src/infrastructure/state.ts\";",
      "import { stackState } from \"./.upstream/apps/hosted/cloud/src/infrastructure/state-v2.ts\";"),
  ]) {
    assert.equal(report.databaseChanged, true);
    assert.equal(report.workflowChanged, true);
  }
  // A resource group this cannot see into is not clear.
  const unseen = classifyStack(replaced("      Effect.orDie,\n    );\n", "      Effect.orDie,\n    );\n    yield* edgeResources;\n"));
  assert.equal(unseen.evidence.database.sources[0]?.state, "unknown");
  assert.equal(unseen.evidence.workflow.sources[0]?.state, "unknown");
});

const unknownBoth = (report: ReturnType<typeof classifyStack>, label: string) => {
  assert.equal(report.evidence.database.state, "unknown", label);
  assert.equal(report.evidence.workflow.state, "unknown", label);
};

test("control flow that can skip resources is unknown", () => {
  const deployed = replaced("    return { url: router.url, emailReady };",
    "    yield* cloudDeployment;\n    const api = yield* Api;\n    return { url: router.url, emailReady };");
  const edit = (from: string, to: string) => {
    assert.ok(deployed.includes(from), from);
    return classifyStack(deployed.replace(from, to), deployed);
  };
  const zoneCheck = "    if (!zone) return yield* Effect.die(new Error(\"Cloudflare zone for this stage is missing\"));\n";
  unknownBoth(edit(zoneCheck, `${zoneCheck}    if (zone.paused) return { url: "", emailReady: false };\n`), "early return");
  unknownBoth(edit("    const api = yield* Api;\n", "    if (process.env.FREEZE) return yield* Effect.die(new Error(\"frozen\"));\n    const api = yield* Api;\n"), "die");
  // An if without braces, and one whose block wraps code that was already there.
  unknownBoth(edit("    yield* cloudDeployment;\n", "    if (preview === undefined)\n    yield* cloudDeployment;\n"), "unbraced if");
  unknownBoth(edit("    yield* cloudDeployment;\n", "    if (preview === undefined) {\n    yield* cloudDeployment;\n    }\n"), "if around existing code");
});

test("indirect resource groups and unreviewed local imports are unknown", () => {
  const audit = replaced("import { Config, Effect } from \"effect\";\n", "import { Config, Effect } from \"effect\";\nimport { auditStore } from \"./scripts/audit-store.ts\";\n")
    .replace("    const router = yield* Cloudflare.Worker(", "    const audit = yield* auditStore();\n    const router = yield* Cloudflare.Worker(");
  unknownBoth(classifyStack(audit), "audit store");
  unknownBoth(classifyStack(replaced("      workersDev: false,\n      compatibility", "      workersDev: false,\n      ...(yield* jobBindings),\n      compatibility")), "spread bindings");
  unknownBoth(classifyStack(replaced("import { Config, Effect } from \"effect\";\n", "import { Config, Effect } from \"effect\";\nimport { helper } from \"./src/helper.ts\";\n")), "local import");
});

test("commands, hidden yields, module loading and rebinding are unknown", () => {
  const after = "    if (!zone) return yield* Effect.die(new Error(\"Cloudflare zone for this stage is missing\"));\n";
  const adding = (lines: string) => classifyStack(replaced(after, `${after}${lines}`));
  const imported = (lines: string) => classifyStack(replaced("import { Config, Effect } from \"effect\";\n", `import { Config, Effect } from "effect";\n${lines}`));
  const cases: Array<[string, ReturnType<typeof classifyStack>]> = [
    ["command", adding("    yield* Command.Exec(\"Migrate\", {\n      command: \"node scripts/migrate.ts\",\n    });\n")],
    ["spaced yield", adding("    const audit = yield *auditStore();\n")],
    ["split yield", adding("    const audit = yield*\n      auditStore();\n")],
    ["template yield", adding("    const label = `${yield* auditStore()}`;\n")],
    ["conditional resource", adding("    const extra = preview === undefined ? yield* Cloudflare.Queue(\"Jobs\") : undefined;\n")],
    ["comment-hidden return", adding("    /**/ if (zone.paused) return { url: \"\", emailReady: false };\n")],
    ["Effect.when", adding("    yield* Effect.when(cleanup, () => paused);\n")],
    ["process.exit", adding("    if (paused) process.exit(0);\n")],
    ["rebinding", adding("    const Cloudflare = fakeCloudflare;\n")],
    ["multi-line import", imported("import {\n  audit,\n} from \"./scripts/evil.ts\";\n")],
    ["re-export", classifyStack(`${stack}export * from "./scripts/evil.ts";\n`)],
    ["dynamic import", adding("    void import(\"./scripts/evil.ts\");\n")],
  ];
  for (const [label, report] of cases) unknownBoth(report, label);
});

test("container classes are Workflow identity and Durable Object jurisdiction is database identity in the stack", () => {
  const container = replaced("    return { url: router.url, emailReady };",
    "    const gateway = yield* Cloudflare.Container(\"Gateway\", {\n      image,\n      instances: 1,\n      maxInstances: 2,\n      className: \"PoolContainer\",\n    });\n    return { url: router.url, emailReady };");
  assert.equal(classifyStack(container.replace("className: \"PoolContainer\"", "className: \"GatewayContainer\""), container).workflowChanged, true);
  const durable = replaced("    return { url: router.url, emailReady };",
    "    const sessions = yield* Cloudflare.DurableObjectNamespace(\"Sessions\", {\n      className: \"Sessions\",\n      sqlite: true,\n      location: \"weur\",\n      scope: \"eu\",\n    });\n    return { url: router.url, emailReady };");
  assert.equal(classifyStack(durable.replace("      scope: \"eu\",\n", "      jurisdiction: \"eu\",\n"), durable).databaseChanged, true);
});

test("a stack change without its contents, or with brackets this cannot match, is unknown", () => {
  const unsupplied = classifySnapshots({
    baseGitCommit: sha("1"), candidateGitCommit: sha("2"), basePins: pins(), candidatePins: pins(),
    localChangedPaths: ["alchemy.run.ts"],
  });
  assert.equal(unsupplied.evidence.database.sources[0]?.state, "unknown");
  assert.equal(unsupplied.evidence.workflow.sources[0]?.state, "unknown");
  const unbalanced = classifyStack(replaced("      workersDev: false,\n", "      workersDev: false, {\n"));
  assert.equal(unbalanced.evidence.database.sources[0]?.state, "unknown");
});
