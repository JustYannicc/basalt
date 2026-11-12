import { bearer, defineProvider, object, secrets, string } from "apps";
import { poolOrigin, productName } from "./deployment.ts";
import { nativePoolAccounts } from "../../src/pool/provider-accounts/definitions.ts";

// The tools service links this account for everyone when it installs a pool.
// Its token works for this one pool only; the pool Worker holds the backend's key.
const pool = defineProvider({
  name: `${productName} pool`,
  hosts: [new URL(poolOrigin).host],
  auth: {
    token: secrets({
      label: "Pool access",
      provisioned: true,
      fields: object({ token: string({ minLength: 1 }) }),
      request: ({ token }) => bearer(token),
    }),
  },
});

export const requirements = {
  dependencies: {
    accountView: {
      scope: "app" as const,
      cardinality: "many" as const,
      tools: { accountView: { kind: "query" as const } },
    },
  },
  app: {
    accounts: {
      pool,
      ...nativePoolAccounts,
    },
  },
};
