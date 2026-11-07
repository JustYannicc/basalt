import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Response from "effect/http/HttpClientResponse";

export const digest = (c) => `sha256:${c.repeat(64)}`;
export const image = (d) => `registry.cloudflare.com/fixture/fixture-pool@${d}`;

export function containerDriftApi({ rolloutOnly = false } = {}) {
  const state = {
    publishedDigest: digest("2"),
    app: {
      id: "fixture-app",
      name: "fixture-pool",
      account_id: "fixture",
      version: 1,
      configuration: { image: image(digest("2")) },
      scheduling_policy: "default",
      max_instances: 1,
      instances: 1,
    },
    writes: 0,
    rollouts: 0,
    registryReads: 0,
    registryMiss: false,
    applicationExists: true,
    updates: [],
  };

  const http = HttpClient.make((request, url) => {
    if (url.hostname === "registry.cloudflare.com") {
      state.registryReads++;
      return Effect.succeed(
        Response.fromWeb(
          request,
          new globalThis.Response(null, {
            status: state.registryMiss ? 404 : 200,
            headers: state.registryMiss ? {} : { "docker-content-digest": state.publishedDigest },
          }),
        ),
      );
    }
    let value = state.app;
    if (url.pathname.endsWith("/credentials")) {
      value = {
        account_id: "fixture",
        registry_host: "registry.cloudflare.com",
        username: "v1",
        password: "synthetic-never-sent",
      };
    } else if (url.pathname.endsWith("/rollouts")) {
      state.writes++;
      state.rollouts++;
      if (rolloutOnly) {
        assert.equal(request.method, "POST");
        assert.equal(request.body._tag, "Uint8Array");
        const body = JSON.parse(Buffer.from(request.body.body).toString());
        const currentVersion = state.app.version;
        const previous = state.app.configuration;
        state.app = {
          ...state.app,
          configuration: body.target_configuration,
          version: currentVersion + 1,
        };
        value = {
          id: `fixture-rollout-${state.rollouts}`,
          current_version: currentVersion,
          target_version: state.app.version,
          current_configuration: previous,
          target_configuration: state.app.configuration,
          status: "completed",
        };
      } else value = { id: "fixture-rollout" };
    } else if (request.method === "DELETE") {
      state.writes++;
      state.applicationExists = false;
    } else if (request.method === "GET" && url.pathname.endsWith("/applications")) {
      value = state.applicationExists ? [state.app] : [];
    } else if (request.method === "GET" && !state.applicationExists) {
      return Effect.succeed(
        Response.fromWeb(
          request,
          globalThis.Response.json(
            {
              success: false,
              errors: [{ code: 1609, message: "Container application not found" }],
            },
            { status: 404 },
          ),
        ),
      );
    } else if (request.method !== "GET") {
      state.writes++;
      state.applicationExists = true;
      assert.equal(request.body._tag, "Uint8Array");
      const body = JSON.parse(Buffer.from(request.body.body).toString());
      if (request.method === "PATCH" || request.method === "PUT") state.updates.push(body);
      // These are Cloudflare's documented presets and actual response units.
      const sizes = {
        basic: {
          vcpu: 0.25,
          memory: "1GiB",
          memory_mib: 1024,
          disk: { size: "4GB", size_mb: 4000 },
        },
        "standard-1": {
          vcpu: 0.5,
          memory: "4GiB",
          memory_mib: 4096,
          disk: { size: "8GB", size_mb: 8000 },
        },
      };
      const resources = sizes[body.configuration?.instance_type];
      if (resources) {
        delete body.configuration.instance_type;
        Object.assign(body.configuration, resources);
      }
      if (rolloutOnly && request.method === "PATCH") {
        const { configuration, ...settings } = body;
        state.app = { ...state.app, ...settings };
      } else state.app = { ...state.app, ...body, version: state.app.version + 1 };
      value = state.app;
    }
    return Effect.succeed(
      Response.fromWeb(
        request,
        globalThis.Response.json({ success: true, errors: [], messages: [], result: value }),
      ),
    );
  });
  return Object.assign(state, { http });
}
