import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { uploadVersion } from "./cloudflare.ts";
import { fixture } from "./test/deploy-stack-fixture.ts";
import { releaseEvidence } from "./evidence.ts";
import { reportRefusal } from "./refusal-report.ts";

for (const scenario of [
  "validation",
  "startup",
  "memory",
  "http",
  "envelope",
  "transport",
  "timeout",
  "abort",
  "missing",
  "success",
] as const)
  test(`real SDK upload ${scenario} preserves safe refusal diagnostics across the promise bridge`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "upload-failure-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const evidence = releaseEvidence(root, "a".repeat(40));
    const requests: string[] = [];
    const client = HttpClient.make((request, url) => {
      assert.equal(request.method, "POST");
      assert.ok(url.pathname.endsWith("/versions"));
      const worker = url.pathname.split("/").at(-2)!;
      requests.push(worker);
      if (worker === "McpServer" && scenario === "transport")
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error("synthetic-private-token"),
            }),
          }),
        );
      const response =
        worker !== "McpServer" || scenario === "success"
          ? Response.json({
              success: true,
              result: { id: `accepted-${worker}`, startup_time_ms: 100 },
            })
          : ["validation", "startup", "memory"].includes(scenario)
            ? Response.json(
                {
                  success: false,
                  errors: [
                    {
                      code: 10021,
                      message:
                        (scenario === "startup"
                          ? "Script startup exceeded CPU time limit"
                          : scenario === "memory"
                            ? "Script startup exceeded memory limit"
                            : "Uncaught Error: No such module") +
                        " synthetic-private-token https://private.invalid",
                    },
                  ],
                },
                { status: 400 },
              )
            : scenario === "http"
              ? new Response("synthetic-private-token", { status: 503 })
              : scenario === "envelope"
                ? Response.json({
                    success: false,
                    errors: [{ code: 10021, message: "synthetic-private-token" }],
                  })
                : Response.json({ success: true, result: { startup_time_ms: 100 } });
      return Effect.succeed(HttpResponse.fromWeb(request, response));
    });
    const proof = fixture({
      extraWorkers: ["McpServer"],
      evidence,
      upload: (worker) =>
        (worker.id === "McpServer" && (scenario === "timeout" || scenario === "abort")
          ? Effect.die(
              scenario === "timeout"
                ? new Cause.TimeoutError("synthetic-private-token")
                : new DOMException("synthetic-private-token", "AbortError"),
            )
          : uploadVersion(worker)
        ).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(
            Credentials,
            Effect.succeed({
              type: "apiToken",
              apiToken: Redacted.make("synthetic-private-token"),
              apiBaseUrl: "https://private.invalid",
            }),
          ),
        ),
    });
    const exit = await Effect.runPromiseExit(proof.effect);
    if (scenario === "success") {
      assert.ok(Exit.isSuccess(exit));
      assert.deepEqual(requests, ["Api", "McpServer", "Router"]);
      assert.equal(proof.receipts.at(-1)?.phase, "complete");
      return;
    }
    assert.ok(Exit.isFailure(exit));
    const failure = await evidence.failure(Cause.squash(exit.cause));
    assert.equal(failure.worker, "McpServer");
    assert.equal(
      failure.reason,
      scenario === "missing" ? "missing-version-id" : "upload-rejected-or-unconfirmed",
    );
    assert.deepEqual(
      requests,
      scenario === "timeout" || scenario === "abort" ? ["Api"] : ["Api", "McpServer"],
    );
    assert.deepEqual(failure.activated, []);
    assert.equal(proof.writes(), 0);
    assert.equal(
      proof.events.some((event) => event.startsWith("activate:")),
      false,
    );
    const receipt = proof.receipts.at(-1)!;
    assert.equal(receipt.phase, "upload");
    assert.equal(receipt.pendingUpload?.worker, "McpServer");
    const summary = join(root, "summary.md");
    const messages: string[] = [];
    await reportRefusal(failure, summary, (message) => messages.push(message));
    const outputs = [
      JSON.stringify(receipt),
      await readFile(join(root, "failure.json"), "utf8"),
      await readFile(summary, "utf8"),
      ...messages,
    ];
    for (const output of outputs) {
      assert.ok(!output.includes("synthetic-private-token"), output);
      assert.ok(!output.includes("private.invalid"), output);
      if (["validation", "startup", "memory"].includes(scenario)) {
        assert.ok(output.includes("400"), output);
        assert.ok(output.includes("10021"), output);
        assert.ok(
          output.includes(
            scenario === "startup"
              ? "startup-limit"
              : scenario === "memory"
                ? "startup-memory"
                : "module-resolution",
          ),
          output,
        );
      } else if (scenario === "http") assert.ok(output.includes("503"), output);
      else if (scenario === "envelope") assert.ok(output.includes("200"), output);
      else if (scenario === "transport") assert.ok(output.includes("TransportError"), output);
      else if (scenario === "timeout") assert.ok(output.includes("TimeoutError"), output);
      else if (scenario === "abort") assert.ok(output.includes("AbortError"), output);
    }
  });
