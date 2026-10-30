import { bearer, defineProvider, interactive, object, secrets, string, type InteractiveMethod } from "apps";
import { poolOrigin, productName } from "./deployment.ts";
import { providers } from "./providers.ts";
import { loginFileMethod } from "./sign-in.ts";

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

// Each subscription the pool serves is an account here, connected from the app's Accounts tab.
// One sign-in method per service the backend signs in, plus pasting a login file.
const subscription = defineProvider({
  name: "Subscription",
  auth: {
    ...Object.fromEntries(providers.map(({ id, name }) => [id, interactive({ label: name })])),
    [loginFileMethod]: interactive({ label: "Login file" }),
  } as Readonly<Record<string, InteractiveMethod>>,
});

export const requirements = { app: { accounts: { pool, subscriptions: subscription.many() } } };
