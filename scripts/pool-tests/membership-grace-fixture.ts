import { NativeMemberships } from "../../src/pool/membership.ts";
import { NativeStreams } from "../../src/pool/native-streams.ts";
import { installNativePolicy } from "../../src/pool/native-policy-install.ts";
import {
  membershipPrefix,
  policyPrefix,
  type NativeMembershipPolicy,
  type NativeMembershipSnapshot,
} from "../../src/pool/membership-contract.ts";
import { openEnvelope, signEnvelope } from "../../src/pool/token.ts";

export const membershipSigningKey = "7c".repeat(32);
const key = membershipSigningKey;

export function membershipGraceFixture() {
  let now = Date.now();
  let fault: "none" | "install400" | "read" | "reconcile" = "none";
  let selected = ["saved-account"];
  let actual: string[] | undefined;
  let native = true;
  let installed: NativeMembershipPolicy | undefined;
  const stored = new Map<string, unknown>();
  const aborted: string[] = [];
  const streams = new NativeStreams();
  const container = {
    getTcpPort: () => ({
      fetch: async (_input: string, init: RequestInit) => {
        if (fault === "install400")
          return Response.json({ error: "invalid_projection" }, { status: 400 });
        const { projection } = JSON.parse(String(init.body)) as { projection: string };
        installed = (await openEnvelope(key, policyPrefix, projection)) as NativeMembershipPolicy;
        return Response.json({ installed: true, revision: installed.revision });
      },
    }),
  };
  const dependencies = {
    storage: {
      get: async <T>(name: string) => structuredClone(stored.get(name)) as T | undefined,
      put: async (name: string, value: unknown) => {
        stored.set(name, structuredClone(value));
      },
    },
    signingKey: key,
    now: () => now,
    read: async (pool: string, organization: string): Promise<NativeMembershipSnapshot> => {
      if (fault === "read") throw new Error("control plane unavailable");
      return {
        pool,
        organization,
        native,
        accounts: selected.map((homeReference) => ({
          account: homeReference,
          requirement: "subscriptions",
          provider: "codex",
          method: "codex",
          generation: 1,
          driver: "basalt-home",
          driverRevision: "1",
          bindingRevision: "1",
          homeReference,
        })),
      };
    },
    actual: async () => actual ?? selected,
    reconcile: async () => {
      if (fault === "reconcile") throw new Error("Home unavailable");
    },
    install: (policy: NativeMembershipPolicy) =>
      installNativePolicy(container, { signingKey: key, managementKey: "fixture-only" }, policy),
    abort: (pool: string) => {
      aborted.push(pool);
      streams.abortPool(pool);
    },
    schedule: async () => {},
  };
  return {
    dependencies,
    aborted,
    streams,
    installed: () => installed,
    fault: (value: typeof fault) => {
      fault = value;
    },
    select: (value: string[]) => {
      selected = value;
    },
    actual: (value: string[] | undefined) => {
      actual = value;
    },
    native: (value: boolean) => {
      native = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    reserve: async (memberships: NativeMemberships) =>
      memberships.reserve(
        new Request("https://pool.invalid/pool/v1/membership", {
          method: "POST",
          body: JSON.stringify({
            envelope: await signEnvelope(key, membershipPrefix, {
              pool: "pool",
              organization: "organization",
              at: now,
              expiresAt: now + 30_000,
            }),
          }),
        }),
      ),
  };
}
