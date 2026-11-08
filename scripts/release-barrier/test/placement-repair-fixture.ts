import assert from "node:assert/strict";
import type { PreparedWorkerUpload } from "alchemy/Cloudflare/Workers/WorkerUploadHook";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { Effect, Layer, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { placementRepairTargets } from "../pending-placement.ts";

export function placementRepairFixture(events: string[]) {
  const target = placementRepairTargets[0];
  let activated = false;
  const placement = {
    mode: "targeted",
    target: [{ id: 39, region: "aws:eu-central-1", type: "region" }],
  };
  const scriptSettings = {
    tags: ["alchemy:id:fixture"],
    logpush: true,
    tailConsumers: [{ service: "fixture-tail" }],
    observability: { enabled: true },
  };
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      assert.equal(request.method, "GET");
      assert.ok(url.pathname.includes(`/${target.scriptName}/`));
      let result: unknown;
      if (url.pathname.endsWith("/deployments")) {
        result = {
          deployments: [
            {
              id: target.deployment,
              created_on: "2026-11-08T00:00:00Z",
              source: "api",
              strategy: "percentage",
              versions: [{ version_id: target.version, percentage: 100 }],
            },
          ],
        };
      } else if (url.pathname.endsWith("/settings")) {
        events.push(`repair-settings:${activated ? "after" : "before"}`);
        result = {
          tags: scriptSettings.tags,
          logpush: scriptSettings.logpush,
          tail_consumers: [{ service: "fixture-tail" }],
          observability: scriptSettings.observability,
          ...(activated
            ? { placement: { mode: "targeted", target: [39] }, limits: { subrequests: 50000 } }
            : {}),
        };
      } else {
        const id = url.pathname.split("/").at(-1)!;
        assert.ok([target.version, target.prior, "accepted-Api"].includes(id));
        events.push(`repair-version:${id}:${activated ? "after" : "before"}`);
        result = {
          id,
          resources:
            id === target.version
              ? {}
              : { script: { placement }, script_runtime: { limits: { subrequests: 50000 } } },
        };
      }
      return HttpResponse.fromWeb(
        request,
        Response.json({ success: true, errors: [], messages: [], result }),
      );
    }),
  );
  return {
    services: Layer.mergeAll(
      Layer.succeed(HttpClient.HttpClient, client),
      Layer.succeed(
        Credentials,
        Effect.succeed({
          type: "apiToken",
          apiToken: Redacted.make("synthetic"),
          apiBaseUrl: "https://fixture.invalid",
        }),
      ),
    ),
    prepare(upload: PreparedWorkerUpload) {
      if (upload.fqn !== "Api") return upload;
      return {
        ...upload,
        request: {
          ...upload.request,
          scriptName: target.scriptName,
          metadata: {
            ...upload.request.metadata,
            ...scriptSettings,
            placement: { region: "aws:eu-central-1" },
            limits: { subrequests: 50000 },
          },
        },
        previousSettings: { ...scriptSettings },
      };
    },
    activate(id: string) {
      if (id === "Api") activated = true;
    },
    baseline(scriptName: string) {
      return [
        {
          versionId: scriptName === target.scriptName ? target.version : "previous",
          percentage: 100,
        },
      ];
    },
  };
}
