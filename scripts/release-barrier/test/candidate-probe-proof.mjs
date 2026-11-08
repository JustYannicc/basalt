import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { baselineRoles } from "../baseline-probe.ts";
import { candidateScriptSettings } from "../candidate-settings.ts";
import { fixtureAccount } from "../../architecture/native-stack-fixtures.ts";

/** Real entrypoint, synthetic CI inputs and an owned production inventory, inside the OS sandbox. */
export async function candidateProbeProof(settings, mode, declarationHttp, source) {
  const workers = baselineRoles.map((role) => ({
    role,
    scriptName: `basalt-${role.toLowerCase()}-production-fixture`,
  }));
  const scripts = workers.map((worker) => ({
    id: worker.scriptName,
    tags: ["alchemy:stack:basalt", "alchemy:stage:production", `alchemy:id:${worker.role}`],
  }));
  const prefix = `/client/v4/accounts/${fixtureAccount}`;
  const requests = [];
  let declarations = [];
  let denied = false;
  const snake = (value) =>
    Array.isArray(value)
      ? value.map(snake)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
              key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
              snake(item),
            ]),
          )
        : value;
  const fixture = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = init?.method ?? request?.method ?? "GET";
    if (
      method !== "GET" ||
      init?.body != null ||
      request?.body != null ||
      url.origin !== "https://api.cloudflare.com"
    ) {
      denied = true;
      throw new Error("Candidate proof denied request");
    }
    requests.push(url.pathname);
    let result;
    if (url.pathname === `${prefix}/workers/scripts` && !url.search) result = scripts;
    else if (
      url.pathname === `${prefix}/workers/durable_objects/namespaces` &&
      [...url.searchParams].length === 1 &&
      url.searchParams.get("page") === "1"
    )
      result = [];
    else {
      const worker = declarations.find((item) =>
        url.pathname.startsWith(`${prefix}/workers/scripts/${item.scriptName}/`),
      );
      if (worker && !url.search && url.pathname.endsWith("/deployments"))
        result = {
          deployments: [
            {
              id: "deployment",
              created_on: "2026-11-01T00:00:00Z",
              source: "api",
              strategy: "percentage",
              versions: [{ version_id: "active", percentage: 100 }],
            },
          ],
        };
      else if (worker && !url.search && url.pathname.endsWith("/settings")) {
        result = snake(worker.metadata);
        if (worker.metadata.placement) result.placement = { mode: "targeted", target: [39] };
      } else if (worker && !url.search && url.pathname.endsWith("/versions/active"))
        result = {
          id: "active",
          resources: {
            script: {
              placement: {
                mode: "targeted",
                target: [{ id: 39, type: "region", region: "aws:eu-central-1" }],
              },
            },
          },
        };
      else return declarationHttp.fetch(input, init);
    }
    const count = Array.isArray(result) ? result.length : 0;
    return Response.json({
      success: true,
      result,
      errors: [],
      messages: [],
      result_info: { page: 1, per_page: 100, count, total_count: count, total_pages: 1 },
    });
  };
  globalThis.fetch = fixture;
  declarations = await candidateScriptSettings(workers, settings);
  if (mode === "entry-missing-attempt") delete process.env.BASALT_RELEASE_ATTEMPT;
  Object.assign(process.env, source, {
    GITHUB_ACTIONS: "true",
    GITHUB_STEP_SUMMARY: join(process.cwd(), "summary.md"),
  });
  const errors = [];
  console.error = (message) => errors.push(message);
  await import("../baseline-probe-entry.ts");
  declarationHttp.assertAllowed();
  if (denied) throw new Error("Candidate proof denied request");
  const rows = JSON.parse(await readFile(".local/baseline-probe.json", "utf8"));
  const summary = await readFile("summary.md", "utf8");
  process.exitCode = 0;
  return {
    rows,
    summary,
    errors,
    namespaceReads: requests.filter((path) => path.endsWith("/durable_objects/namespaces")).length,
  };
}
