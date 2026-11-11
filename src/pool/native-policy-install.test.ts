import assert from "node:assert/strict";
import { test } from "node:test";
import { installNativePolicy } from "./native-policy-install.ts";
import { poolGuard } from "./guard-failure.ts";
import { failureResponse, poolFailureDiagnostic } from "./json.ts";

const secret = "private-native-install-exception";
const policy = {
  pool: "fixture-pool",
  organization: "fixture-organization",
  revision: 1,
  expiresAt: 15_000,
  accounts: [],
  dirty: false,
};
const keys = { signingKey: "ab".repeat(32), managementKey: "fixture-management-key" };

for (const status of [400, 409, 503])
  test(`HTTP ${status} survives a rejected response cleanup`, async (t) => {
    t.mock.method(performance, "now", () => 100);
    const reports: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => reports.push(args));
    const container = {
      getTcpPort: () => ({
        fetch: async () => {
          const body = new ReadableStream({
            start: (controller) => {
              if (status !== 503) controller.error(new Error(secret));
            },
            cancel: () => Promise.reject(new Error(secret)),
          });
          return new Response(body, { status });
        },
      }),
    };
    await assert.rejects(
      poolGuard("native_policy_install", () => installNativePolicy(container, keys, policy)),
      (error) => {
        const expected = {
          guard: "native_policy_install",
          failure: "response_status",
          backendStatus: status,
          phase: "acknowledgement",
          elapsedMs: 0,
          deadlineAborted: false,
        };
        assert.deepEqual(poolFailureDiagnostic(error), expected);
        const response = failureResponse(error);
        assert.equal(response.status, 503);
        assert.deepEqual(reports, [["pool_guard_failure", expected]]);
        assert.ok(!JSON.stringify(reports).includes(secret));
        return true;
      },
    );
  });

for (const phase of ["request", "acknowledgement"] as const)
  test(`${phase} rejection records its phase and elapsed time without backend text`, async (t) => {
    let now = 100;
    t.mock.method(performance, "now", () => now);
    const container = {
      getTcpPort: () => ({
        fetch: async () => {
          now = 112.4;
          if (phase === "request") throw new Error(secret);
          return new Response(
            new ReadableStream({ start: (controller) => controller.error(new Error(secret)) }),
          );
        },
      }),
    };
    await assert.rejects(
      poolGuard("native_policy_install", () => installNativePolicy(container, keys, policy)),
      (error) => {
        assert.deepEqual(poolFailureDiagnostic(error), {
          guard: "native_policy_install",
          failure: "transport",
          phase,
          elapsedMs: 12,
          deadlineAborted: false,
        });
        return true;
      },
    );
  });

for (const phase of ["request", "acknowledgement"] as const)
  for (const name of ["AbortError", "TimeoutError"])
    test(`${phase} ${name} keeps its failure class and records the local deadline with bounded elapsed time`, async (t) => {
      let now = 100;
      t.mock.method(performance, "now", () => now);
      const controller = new AbortController();
      t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
        assert.equal(milliseconds, 2_000);
        return controller.signal;
      });
      const fail = () => {
        now = 100_000;
        controller.abort(new DOMException(secret, "TimeoutError"));
        throw new DOMException(secret, name);
      };
      const container = {
        getTcpPort: () => ({
          fetch: async () => {
            if (phase === "request") return fail();
            const response = new Response("");
            t.mock.method(response, "text", async () => fail());
            return response;
          },
        }),
      };
      await assert.rejects(
        poolGuard("native_policy_install", () => installNativePolicy(container, keys, policy)),
        (error) => {
          assert.deepEqual(poolFailureDiagnostic(error), {
            guard: "native_policy_install",
            failure: name === "TimeoutError" ? "timeout" : "transport",
            phase,
            elapsedMs: 60_000,
            deadlineAborted: true,
          });
          return true;
        },
      );
    });
