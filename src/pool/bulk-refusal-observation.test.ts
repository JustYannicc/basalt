import assert from "node:assert/strict";
import { test } from "node:test";
import { brand } from "../../brand.ts";
import { handleRequest, type RouterEnv } from "../router.ts";
import { traceRequest } from "../telemetry/traces.ts";
import { routeBulkImport } from "./model-history/bulk-http.ts";
import { bulkImportPath } from "./model-history/bulk-contract.ts";
import { HistoryConflict } from "./model-history/store.ts";

import { signEnvelope } from "./token.ts";

const key = "ab".repeat(32);
const telemetry = {
  SENTRY_DSN: "https://fixture_public_key@o123.ingest.de.sentry.io/456",
  SENTRY_OTLP_ENDPOINT: "https://o123.ingest.de.sentry.io/api/456/integration/otlp/v1/traces",
};

async function statusRequest(
  input: Record<string, unknown> = { operation: "status", job: "a".repeat(64) },
  signingKey = key,
) {
  const envelope = await signEnvelope(signingKey, "sbs1", {
    action: "importUsageBulk",
    pool: "fixture-pool",
    organization: "fixture-org",
    owner: "fixture-owner",
    user: "fixture-owner",
    expiresAt: Date.now() + 25_000,
    input,
  });
  return new Request(`https://${brand.host}${bulkImportPath}`, {
    method: "POST",
    body: JSON.stringify({ envelope }),
    headers: {
      "content-type": "application/json",
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    },
  });
}

function jobsWith(fetch: () => Promise<Response>) {
  return { jurisdiction: () => ({ getByName: () => ({ fetch }) }) };
}

async function observe(request: Request, jobs?: Parameters<typeof routeBulkImport>[1]["jobs"]) {
  const events: string[] = [];
  const spans: { status?: { code: number } }[] = [];
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil: (work: Promise<unknown>) => {
      pending.push(work);
    },
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (request, init) => {
    const body = await new Response(init?.body).text();
    if (String(request).endsWith("/traces")) {
      const data = JSON.parse(body);
      spans.push(...data.resourceSpans[0].scopeSpans[0].spans);
    } else events.push(body);
    return new Response(null, { status: 204 });
  };
  try {
    const env: RouterEnv = {
      ...telemetry,
      POOL_APP_SIGNING_KEY: key,
      CATALOG_SERVICE: {
        fetch: async () => {
          throw new Error("wrong service");
        },
      },
      TOOLS_SERVICE: {
        fetch: async () => {
          throw new Error("wrong service");
        },
      },
      POOL_SERVICE: {
        fetch: (request) =>
          traceRequest(
            telemetry,
            request,
            // Node's Request(Request) loses BYOB support; workerd supplies a byte stream at each hop.
            async (forwarded) =>
              routeBulkImport(
                new Request(forwarded.url, {
                  method: forwarded.method,
                  headers: forwarded.headers,
                  body: await forwarded.text(),
                }),
                { signingKey: key, jobs },
              ),
            context,
          ),
      },
    };
    const response = await handleRequest(request, env, context);
    await Promise.all(pending);
    return { response, events, spans };
  } finally {
    globalThis.fetch = original;
  }
}

function expectedRefusal(observation: Awaited<ReturnType<typeof observe>>, status: number) {
  assert.equal(observation.response.status, status);
  assert.deepEqual(
    observation.events,
    [],
    "neither Router nor PoolWorker may report an expected refusal",
  );
  assert.equal(observation.spans.length, 2);
  assert.ok(
    observation.spans.every((span) => span.status?.code !== 2),
    "expected refusals must not mark error spans",
  );
}

test("an unprovisioned bulk status refuses below server error at both telemetry hops", async () => {
  const result = await observe(await statusRequest());
  expectedRefusal(result, 409);
  assert.deepEqual(await result.response.json(), {
    error: "bulk_import_not_provisioned",
    message: "Bulk import is not provisioned yet.",
  });
});

test("bulk authentication, input, identity and authorization refusals stay out of error telemetry", async () => {
  expectedRefusal(await observe(await statusRequest(undefined, "cd".repeat(32))), 401);
  expectedRefusal(await observe(await statusRequest({ operation: "status", job: "invalid" })), 400);
  expectedRefusal(
    await observe(
      await statusRequest(),
      jobsWith(async () => {
        throw new HistoryConflict();
      }),
    ),
    409,
  );
  expectedRefusal(
    await observe(
      await statusRequest(),
      jobsWith(async () => Response.json({ error: "forbidden" }, { status: 403 })),
    ),
    403,
  );
});

test("an unexpected bulk backend failure still reports Sentry events and error spans at both hops", async () => {
  const result = await observe(
    await statusRequest(),
    jobsWith(async () => {
      throw new Error("synthetic backend failure");
    }),
  );
  assert.equal(result.response.status, 503);
  assert.equal((await result.response.json()).error, "backend_unavailable");
  assert.equal(result.events.length, 2);
  assert.ok(result.events.every((event) => event.includes("http_503")));
  assert.equal(result.spans.length, 2);
  assert.ok(result.spans.every((span) => span.status?.code === 2));
});
