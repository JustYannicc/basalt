import assert from "node:assert/strict";
import { Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";

const wireNames = {
  createdOn: "created_on",
  mainModule: "main_module",
  contentType: "content_type",
  contentBase64: "content_base64",
  className: "class_name",
  namespaceId: "namespace_id",
  compatibilityDate: "compatibility_date",
  compatibilityFlags: "compatibility_flags",
  cacheOptions: "cache_options",
  cpuMs: "cpu_ms",
  startupTimeMs: "startup_time_ms",
  versionId: "version_id",
  packageDependencies: "package_dependencies",
  usageModel: "usage_model",
};
const wire = (value) =>
  Array.isArray(value)
    ? value.map(wire)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [wireNames[k] ?? k, wire(v)]))
      : value;

export function firstHandoffWorkerHttp({
  manifest,
  f,
  options,
  events,
  applyBindings,
  applications,
}) {
  const baseline = manifest.baseline;
  const candidate = manifest.candidate;
  const { legacyApplication, candidateApplication } = applications;
  const { accountId, scriptName } = baseline;
  let deploymentId = baseline.deploymentId;
  const versions = new Map([[baseline.version.id, wire(baseline.version)]]);
  let deployed = baseline.version.id;
  const desired = () =>
    versions.get(deployed).bindings.find((b) => b.name === "POOL_IMAGE_HASH").text;
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      assert.equal(url.origin, "https://api.cloudflare.com");
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined;
      const base = `/client/v4/accounts/${accountId}`;
      let result;
      if (
        request.method === "GET" &&
        url.pathname === `${base}/workers/scripts/${scriptName}/deployments`
      ) {
        result = {
          deployments: [
            {
              id: deploymentId,
              created_on: "2026-11-09T00:00:00Z",
              source: "api",
              strategy: "percentage",
              versions: [{ version_id: deployed, percentage: 100 }],
            },
          ],
        };
      } else if (
        request.method === "GET" &&
        url.pathname.startsWith(`${base}/workers/workers/${scriptName}/versions/`)
      ) {
        result = structuredClone(versions.get(url.pathname.split("/").at(-1)));
        if (options.redactSecrets)
          result.bindings = result.bindings.map((b) =>
            b.type === "secret_text" ? { name: b.name, type: b.type } : b,
          );
      } else if (
        request.method === "POST" &&
        url.pathname === `${base}/workers/workers/${scriptName}/versions`
      ) {
        assert.equal(url.searchParams.get("deploy"), "false");
        const id = versions.size === 1 ? "handoff-preserved-version" : "handoff-current-version";
        const bindings = body.bindings.map((b) =>
          b.type === "inherit"
            ? structuredClone(versions.get(b.version_id).bindings.find((v) => v.name === b.name))
            : b,
        );
        result = {
          ...body,
          id,
          number: versions.size + 1,
          urls: [],
          created_on: "2026-11-09T00:00:00Z",
          startup_time_ms: 50,
          bindings,
        };
        versions.set(id, result);
        events.push({
          action: "upload",
          version: id,
          desired: bindings.find((b) => b.name === "POOL_IMAGE_HASH").text,
        });
      } else if (
        request.method === "POST" &&
        url.pathname === `${base}/workers/scripts/${scriptName}/deployments`
      ) {
        assert.equal(body.versions.length, 1);
        assert.equal(body.versions[0].percentage, 100);
        deployed = body.versions[0].version_id;
        deploymentId = `deployment-${deployed}`;
        const bindings = Object.fromEntries(
          versions
            .get(deployed)
            .bindings.filter((b) => b.type === "plain_text" || b.type === "secret_text")
            .map((b) => [b.name, b.text]),
        );
        if (!("POOL_APP_SIGNING_KEY_PREVIOUS" in bindings))
          bindings.POOL_APP_SIGNING_KEY_PREVIOUS = undefined;
        if (options.wrongRuntimeSecret && deployed === "handoff-current-version") {
          bindings.POOL_MANAGEMENT_KEY = "synthetic-wrong-management";
          f.candidate.env.POOL_MANAGEMENT_KEY = bindings.POOL_MANAGEMENT_KEY;
        }
        applyBindings(bindings);
        events.push({ action: "activate", version: deployed, desired: desired() });
        if (options.lostEnvironmentActivation && deployed === "handoff-current-version")
          throw new Error("lost current environment activation reply");
        result = {
          id: deploymentId,
          created_on: "2026-11-09T00:00:00Z",
          source: "api",
          strategy: "percentage",
          versions: body.versions,
        };
      } else throw new Error(`UNEXPECTED PROVIDER EFFECT ${request.method} ${url.pathname}`);
      return HttpResponse.fromWeb(
        request,
        Response.json({ success: true, errors: [], messages: [], result }),
      );
    }),
  );
  const fetcher = async (input, init) => {
    assert.equal(init.method, "GET");
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.cloudflare.com");
    const app = url.pathname.includes(candidate.target.applicationId)
      ? candidateApplication
      : legacyApplication;
    const runtime = app === candidateApplication ? f.candidate : f.old;
    const instances = url.pathname.endsWith("/instances-v2");
    const running = runtime === f.old ? !f.old.calls.destroy : !!f.candidate.calls.start;
    const result = instances
      ? running
        ? [
            {
              id: runtime.target.instanceId,
              application_id: app.id,
              status: { state: "running" },
              image: app.configuration.image,
            },
          ]
        : []
      : app;
    return Response.json({
      success: true,
      errors: [],
      result,
      result_info: { next_page_token: "" },
    });
  };
  return { client, desired, fetcher };
}
