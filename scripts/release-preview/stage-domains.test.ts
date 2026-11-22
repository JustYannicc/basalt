import assert from "node:assert/strict";
import { test } from "node:test";
import { domainFacts, readWorkerDomains, stageWorkerNames } from "./stage-domains.ts";
import { fingerprint } from "./stage-probe.ts";

const scope = {
  label: "rehearsal-1",
  domain: "stage.example",
  stage: "test-rehearsal-1",
  workers: new Set(["basalt-rehearsal-mcp-test-rehearsal-1"]),
};

test("a stage's Workers are the names its State's Worker rows record, old generations included", () => {
  assert.deepEqual(
    [
      ...stageWorkerNames([
        {
          resourceType: "Cloudflare.Worker",
          attr: { workerName: "a" },
          old: { attr: { workerName: "b" } },
        },
        { resourceType: "Cloudflare.Workflow", attr: { workerName: "not-a-worker-row" } },
        null,
      ]),
    ].sort(),
    ["a", "b"],
  );
});

test("each domain on the stage's label or Workers is listed with both facts; a production host is shown as none", () => {
  const facts = domainFacts(
    [
      {
        id: "own",
        hostname: "mcp.rehearsal-1.stage.example",
        service: "basalt-rehearsal-mcp-test-rehearsal-1",
      },
      // Under the label, pointing at a Worker the stage does not own.
      {
        id: "foreign-service",
        hostname: "api.rehearsal-1.stage.example",
        service: "basalt-production-api",
      },
      // A stage Worker carrying a production hostname.
      {
        id: "production-host",
        hostname: "app.production.example",
        service: "basalt-rehearsal-mcp-test-rehearsal-1",
      },
      // Neither: never listed.
      { id: "production", hostname: "mcp.production.example", service: "basalt-production-mcp" },
      {
        id: "neighbour",
        hostname: "mcp.rehearsal-10.stage.example",
        service: "basalt-rehearsal-mcp-test-rehearsal-10",
      },
    ],
    scope,
  );
  assert.deepEqual(facts, [
    {
      id: fingerprint("own"),
      hostname: "mcp.rehearsal-1.<stage domain>",
      service: "basalt-rehearsal-mcp-test-rehearsal-1",
      underLabel: true,
      serviceInState: true,
      serviceStageNamed: true,
    },
    {
      id: fingerprint("foreign-service"),
      hostname: "api.rehearsal-1.<stage domain>",
      service: "basalt-production-api",
      underLabel: true,
      serviceInState: false,
      serviceStageNamed: false,
    },
    {
      id: fingerprint("production-host"),
      hostname: null,
      service: "basalt-rehearsal-mcp-test-rehearsal-1",
      underLabel: false,
      serviceInState: true,
      serviceStageNamed: true,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(facts), /production\.example|"own"/u);
});

test("the domain list is read page by page until its last page", async () => {
  const pages: string[] = [];
  const send: typeof fetch = async (input) => {
    const page = new URL(String(input)).searchParams.get("page")!;
    pages.push(page);
    return Response.json({
      success: true,
      result: [{ id: `d${page}` }],
      result_info: { total_pages: 2 },
    });
  };
  const domains = await readWorkerDomains({ accountId: "a".repeat(32), token: "t" }, send);
  assert.deepEqual(pages, ["1", "2"]);
  assert.equal(domains.length, 2);
});
