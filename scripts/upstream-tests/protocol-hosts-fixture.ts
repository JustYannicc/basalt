import { Effect, Redacted, Schema } from "effect";
import { AccountId } from "../../.upstream/packages/apps/src/contracts/schema.ts";
import type {
  HostAccount,
  HostAccounts,
} from "../../.upstream/packages/apps/src/contracts/host.ts";
import { HostInvocation } from "../../.upstream/packages/apps/src/contracts/host.ts";
import {
  WorkflowRunId,
  type WorkflowExecution,
} from "../../.upstream/packages/apps/src/contracts/workflows.ts";
import { credentialKey } from "../../.upstream/packages/sdk/src/implementation/credential-handles.ts";

export const app = "protocol-hosts-fixture";
export const key = credentialKey("42".repeat(32));
export const hosts = ["strict.example.test", "svc_one.example.test:8443"];
export const account = (allowed: readonly string[] | undefined = hosts) =>
  ({
    id: AccountId.make("acc_protocol_hosts"),
    provider: {
      name: "Host fixture",
      auth: {},
      ...(allowed === undefined ? {} : { hosts: allowed }),
    },
    method: "key",
    generation: 7,
    oauthScopes: ["read"],
    mcpEndpoint: "https://mcp.example.test/server",
    fields: { token: "synthetic-protocol-hosts-token" },
  }) satisfies HostAccount;

export const accounts = (selected: HostAccount = account()): HostAccounts => ({
  app: { one: selected, many: [selected], empty: [] },
  user: { one: selected, many: [selected], empty: [] },
});

export const invocation = (selected: HostAccounts) => ({
  ...Schema.decodeUnknownSync(HostInvocation)({
    command: { operation: "inspect" },
    accounts: { app: {} },
    caller: "caller-protocol-fixture",
  }),
  accounts: selected,
});

export const workflow = (resolve: WorkflowExecution["resolve"]): WorkflowExecution => ({
  runId: WorkflowRunId.make("protocol-hosts-workflow"),
  driver: {
    do: (_name, _options, run) => run(),
    sleep: () => Effect.void,
    sleepUntil: () => Effect.void,
  },
  resolve,
  invoke: () => Effect.succeed(null),
});

export const context = (selected: HostAccounts) => ({ accounts: Redacted.make(selected) });
