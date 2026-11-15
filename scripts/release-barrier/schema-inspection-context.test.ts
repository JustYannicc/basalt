import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createRequire } from "node:module";
import { withSchemaInspectionContext } from "./schema-inspection-context.ts";

const { parse } = createRequire(new URL("../architecture/package.json", import.meta.url))("yaml");

const candidate = "a".repeat(40);
const trusted = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "JustYannicc/basalt",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: candidate,
  BASALT_PREFLIGHT_STATE_URL: "https://state.example.test",
  BASALT_PREFLIGHT_STATE_TOKEN: "synthetic-read-only-token-12345678",
};

test("schema inspection admits only the fixed selection at the exact trusted main checkout", async () => {
  const result = await withSchemaInspectionContext(
    trusted,
    candidate,
    "schema-v1",
    async (context) => ({
      candidate: context.candidate,
      selection: context.selection,
      stateUrl: context.stateUrl,
      token: context.token,
    }),
  );
  assert.deepEqual(result, {
    candidate,
    selection: "schema-v1",
    stateUrl: trusted.BASALT_PREFLIGHT_STATE_URL,
    token: trusted.BASALT_PREFLIGHT_STATE_TOKEN,
  });
});

test("untrusted dispatches and selection changes refuse before opening State or SQL", async () => {
  let opened = 0;
  const open = async () => {
    opened++;
  };
  for (const changes of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_EVENT_NAME: "pull_request_target" },
    { GITHUB_REPOSITORY: "fork/basalt" },
    { GITHUB_REF: "refs/pull/12/merge" },
    { GITHUB_REF: "refs/heads/batch/b93t" },
    { GITHUB_SHA: "b".repeat(40) },
  ])
    await assert.rejects(
      withSchemaInspectionContext({ ...trusted, ...changes }, candidate, "schema-v1", open),
      /^Error: schema-inspection-untrusted-context$/,
    );
  for (const checkout of ["", "main", "a".repeat(39), "b".repeat(40)])
    await assert.rejects(
      withSchemaInspectionContext(trusted, checkout, "schema-v1", open),
      /^Error: schema-inspection-untrusted-context$/,
    );
  for (const selection of ["", "schema-v2", "SELECT * FROM accounts", "schema-v1\n"])
    await assert.rejects(
      withSchemaInspectionContext(trusted, candidate, selection, open),
      /^Error: schema-inspection-selection-unsupported$/,
    );
  assert.equal(opened, 0);
});

test("missing scoped credentials refuse before opening State or SQL without release-token fallback", async () => {
  let opened = 0;
  for (const key of ["BASALT_PREFLIGHT_STATE_URL", "BASALT_PREFLIGHT_STATE_TOKEN"])
    for (const value of [undefined, "", " "])
      await assert.rejects(
        withSchemaInspectionContext(
          {
            ...trusted,
            [key]: value,
            ALCHEMY_STATE_TOKEN: "synthetic-full-token",
            CLOUDFLARE_API_TOKEN: "synthetic-provider-token",
          },
          candidate,
          "schema-v1",
          async () => {
            opened++;
          },
        ),
        /^Error: schema-inspection-credentials-unavailable$/,
      );
  for (const token of ["a".repeat(31), "a".repeat(513)])
    await assert.rejects(
      withSchemaInspectionContext(
        { ...trusted, BASALT_PREFLIGHT_STATE_TOKEN: token },
        candidate,
        "schema-v1",
        async () => {
          opened++;
        },
      ),
      /^Error: schema-inspection-credentials-unavailable$/,
    );
  assert.equal(opened, 0);
});

test("the inspection workflow has only protected read credentials and shares the release lock", async () => {
  const workflow = parse(
    await readFile(
      new URL("../../.github/workflows/production-schema-inspection.yml", import.meta.url),
      "utf8",
    ),
  );
  const release = parse(
    await readFile(new URL("../../.github/workflows/release-main.yml", import.meta.url), "utf8"),
  );
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs, {
    selection: {
      description: "Fixed schema inspection",
      required: true,
      type: "choice",
      default: "schema-v1",
      options: ["schema-v1"],
    },
  });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, release.concurrency);
  const job = workflow.jobs.inspect;
  assert.equal(
    job.if,
    "github.repository == 'JustYannicc/basalt' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'",
  );
  assert.deepEqual(job.environment, { name: "production-release", deployment: false });
  const checkout = job.steps.find((step: { uses?: string }) => step.uses === "actions/checkout@v4");
  assert.deepEqual(checkout.with, { ref: "${{ github.sha }}", "persist-credentials": false });
  const operation = job.steps.find(
    (step: { run?: string }) =>
      step.run === "bun scripts/release-barrier/schema-inspection-entry.ts",
  );
  assert.deepEqual(operation.env, {
    BASALT_SCHEMA_INSPECTION_SELECTION: "${{ inputs.selection }}",
    BASALT_PREFLIGHT_STATE_URL: "${{ secrets.BASALT_PREFLIGHT_STATE_URL }}",
    BASALT_PREFLIGHT_STATE_TOKEN: "${{ secrets.BASALT_PREFLIGHT_STATE_TOKEN }}",
  });
  const upload = job.steps.find(
    (step: { uses?: string }) => step.uses === "actions/upload-artifact@v4",
  );
  assert.equal(upload.if, "always()");
  assert.equal(upload.with.path, ".local/schema-inspection/receipt.json");
  assert.equal(upload.with["include-hidden-files"], true);
});
