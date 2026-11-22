import assert from "node:assert/strict";
import { test } from "node:test";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import { apiTokenCredentials, Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { Cause, Effect, Exit } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { failureLine, providerError, publicMessage } from "./failure-line.ts";

// Synthetic: no real account, host or digest appears in this file.
const account = "0123456789abcdef0123456789abcdef";
const image = `registry.cloudflare.com/${account}/pool-runtime-blue@sha256:${"e".repeat(64)}`;

/** Cloudflare's answer to a rollout naming a repository that does not hold the digest. */
const refusedRollout = {
  success: false,
  errors: [
    {
      code: 1601,
      message: "IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE",
      details: { registry: "registry.cloudflare.com", image },
    },
  ],
  messages: [],
  result: null,
};

/** The error the SDK raises for an answer, as the apply's failure line receives it. */
const rolloutError = async (status: number, body: unknown) => {
  const exit = await Effect.runPromiseExit(
    Containers.createContainerApplicationRollout({
      accountId: account,
      applicationId: "fixture-application",
      description: "Immediate update",
      strategy: "rolling",
      kind: "full_auto",
      stepPercentage: 100,
      targetConfiguration: { image },
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))),
        ),
      ),
      Effect.provideService(
        Credentials,
        Effect.succeed(
          apiTokenCredentials({
            apiToken: "synthetic-never-sent",
            apiBaseUrl: "https://fixture.invalid",
          }),
        ),
      ),
    ),
  );
  assert.ok(Exit.isFailure(exit), "the stand-in refuses the rollout");
  return Cause.squash(exit.cause);
};

const assertPublic = (line: string) => {
  assert.ok(!line.includes(account), `no account id in ${line}`);
  assert.ok(!line.includes("registry.cloudflare.com"), `no registry host in ${line}`);
  assert.ok(!line.includes("e".repeat(64)), `no digest in ${line}`);
  assert.ok(line.length < 300, `one short line, not ${line.length} characters`);
};

test("Cloudflare's 1601 refusal prints its message, and its code wherever the error keeps one", async () => {
  // Through the SDK: a 400 no operation claims becomes its BadRequest, which keeps Cloudflare's
  // message and drops the code, so the line has the message but cannot have 1601.
  const sdk = failureLine(await rolloutError(400, refusedRollout));
  assert.equal(sdk, "BadRequest (failed): IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE");
  assertPublic(sdk);
  // The same body wherever the chain still carries it: an errors list, or the raw response.
  const listed = failureLine({
    _tag: "CloudflareError",
    status: 400,
    errors: refusedRollout.errors,
  });
  assert.equal(
    listed,
    "CloudflareError (failed, HTTP 400): code 1601, IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE",
  );
  const raw = failureLine({
    _tag: "CloudflareHttpError",
    status: 400,
    statusText: "Bad Request",
    message: `HTTP 400 from https://api.cloudflare.com/client/v4/accounts/${account}/containers`,
    body: JSON.stringify(refusedRollout),
  });
  assert.equal(
    raw,
    "CloudflareHttpError (failed, HTTP 400): code 1601, IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE",
  );
  for (const line of [listed, raw]) assertPublic(line);
});

test("a message that names the image keeps neither the account nor the host", () => {
  const line = publicMessage(
    `IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE: ${image} at https://registry.example/v2`,
  );
  assert.equal(
    line,
    "IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE: {host}/{id}/pool-runtime-blue@{redacted} at {url}",
  );
});

test("nothing it is given makes it throw, and any trouble prints the class-only line", () => {
  const throwing = new Proxy(
    {},
    {
      get() {
        throw new Error("getter");
      },
      has() {
        throw new Error("has");
      },
      getPrototypeOf() {
        throw new Error("prototype");
      },
    },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const circular: Record<string, unknown> = { _tag: "BadRequest", message: "loop" };
  circular.cause = circular;
  circular.errors = [circular, circular];
  const huge = "x1".repeat(512 * 1024);
  const getters = Object.defineProperties(new Error("outer"), {
    code: {
      get() {
        throw new Error("code");
      },
    },
    cause: {
      get() {
        throw new Error("cause");
      },
    },
  });
  const cases: ReadonlyArray<readonly [string, unknown, string]> = [
    ["undefined", undefined, "undefined (failed)"],
    ["a string", "boom", "string (failed)"],
    ["a number", 42, "number (failed)"],
    ["null", null, "object (failed)"],
    ["throwing getters", throwing, "object (failed)"],
    ["a revoked proxy", revoked.proxy, "object (failed)"],
    ["throwing getters on an error", getters, "Error (failed)"],
    ["a circular chain", circular, "BadRequest (failed): loop"],
    ["a 1 MB message", { _tag: "BadRequest", message: huge }, `BadRequest (failed): {redacted}`],
    [
      "a 1 MB body",
      { _tag: "CloudflareHttpError", status: 400, message: "m", body: huge },
      "CloudflareHttpError (failed, HTTP 400)",
    ],
  ];
  for (const [name, error, expected] of cases) {
    let line: string | undefined;
    assert.doesNotThrow(() => (line = failureLine(error)), name);
    assert.equal(line, expected, name);
  }
});

test("long or adversarial text is cut before any pattern runs", () => {
  for (const text of ["a.".repeat(512 * 1024), "a".repeat(1024 * 1024), "-".repeat(1024 * 1024)]) {
    const started = performance.now();
    const line = publicMessage(text);
    assert.ok(line.length <= 201, `${line.length} characters`);
    // Generous: the cut keeps each pattern on 2,000 characters, so this is milliseconds.
    assert.ok(performance.now() - started < 1_000, "redaction stays bounded");
  }
});

test("only a provider's own error contributes a message", () => {
  // A plain error's message can carry hosts or values the log must not print.
  assert.equal(failureLine(new Error("connect failed to pool.example.internal")), "Error (failed)");
  assert.equal(providerError({ message: "no code, no status class" }), undefined);
  // A code from anywhere in the chain, past an uncoded status class.
  assert.deepEqual(
    providerError({
      _tag: "BadRequest",
      message: "outer",
      cause: { code: 7003, message: "inner" },
    }),
    { code: 7003, message: "inner" },
  );
});
