import assert from "node:assert/strict";
import { Effect, Option, Redacted } from "effect";
import { createRequire } from "node:module";
import { load } from "./pool-access-fixture.ts";
const require = createRequire(
  new URL("../../.upstream/apps/hosted/cloud/package.json", import.meta.url),
);
const { betterAuth } = await import(require.resolve("better-auth"));
const { memoryAdapter } = await import(require.resolve("better-auth/adapters/memory"));
const { cloudAuthOptions } = await load("apps/hosted/cloud/src/implementation/auth-options.ts");

export async function nativeAuth() {
  let fail = false;
  const removing: { organization: string; member: string }[] = [];
  const deleting: string[] = [];
  const added: string[] = [];
  const access = {
    memberRemoving: async (organization: string, member: string) => {
      removing.push({ organization, member });
      if (fail) throw new Error("Pool worker unavailable");
    },
    membersAdded: async (organization: string) => {
      added.push(organization);
    },
    userDeleting: async (user: string) => {
      deleting.push(user);
      if (fail) throw new Error("Pool worker unavailable");
    },
  };
  const db: Record<string, any[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
  };
  const url = "http://localhost:3000";
  const settings = {
    url,
    issuer: `${url}/api/auth`,
    resourceOrigins: { api: [url], mcp: [url] },
    callbackOrigin: url,
    oauthRedirectUri: Option.none(),
    oauthProxy: Option.none(),
    trustedOrigins: [],
    emulators: Option.none(),
    chatGpt: Option.none(),
    googleClientId: "unused",
    googleClientSecret: Redacted.make("unused"),
    githubClientId: "unused",
    githubClientSecret: Redacted.make("unused"),
    brand: { name: "Signalbox", logo: { light: "/logo.svg", dark: "/logo.svg" }, links: {} },
    hosts: { sharedCookieDomain: Option.none(), passkey: { rpId: "localhost", origin: url } },
    rateLimitEnabled: false,
  };
  const options = cloudAuthOptions(
    settings,
    [],
    () => Effect.void,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    access,
  );
  const auth = betterAuth({
    ...options,
    secret: "fixture-only-auth-secret-never-used-outside-tests",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true, autoSignIn: false },
    logger: { disabled: true },
  });
  async function signup(name: string) {
    const response = await auth.api.signUpEmail({
      asResponse: true,
      body: { name, email: `${name}@example.invalid`, password: "fixture-password-1234" },
    });
    assert.equal(response.status, 200, await response.clone().text());
    const value = await response.json();
    const user = db.user.find((row) => row.id === value.user.id);
    user.emailVerified = true;
    const signedIn = await auth.api.signInEmail({
      asResponse: true,
      body: { email: user.email, password: "fixture-password-1234" },
    });
    assert.equal(signedIn.status, 200, await signedIn.clone().text());
    const headers = new Headers({
      cookie: signedIn.headers
        .getSetCookie()
        .map((cookie: string) => cookie.split(";")[0])
        .join("; "),
    });
    return { ...value.user, headers };
  }
  const owner = await signup("owner");
  const guest = await signup("guest");
  const spare = await signup("spare");
  const org = await auth.api.createOrganization({
    headers: owner.headers,
    body: { name: "Fixture", slug: "fixture" },
  });
  assert.equal(
    db.member.find((row) => row.userId === owner.id).role,
    "owner",
    "createOrganization retains its creator owner",
  );
  const http = (actor: typeof owner, operation: string, body: unknown) => {
    const headers = new Headers(actor.headers);
    headers.set("content-type", "application/json");
    headers.set("origin", url);
    return auth.handler(
      new Request(`${url}/api/auth/organization/${operation}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
  };
  return {
    auth,
    http,
    db,
    owner,
    guest,
    spare,
    org,
    removing,
    deleting,
    added,
    fail: () => {
      fail = true;
    },
    recover: () => {
      fail = false;
    },
  };
}
