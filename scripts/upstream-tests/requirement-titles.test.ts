import assert from "node:assert/strict";
import { test } from "node:test";

const dashboard = new URL(
  "../../.upstream/packages/ui/src/implementation/dashboard/",
  import.meta.url,
);
type Auth = { readonly type: string; readonly label?: string; readonly provisioned?: boolean };
type Requirement = {
  readonly definition: { readonly name: string; readonly auth: Readonly<Record<string, Auth>> };
  readonly cardinality: "one" | "many";
};
const { requirementTitles } = (await import(new URL("requirement-titles.ts", dashboard).href)) as {
  requirementTitles: (
    requirements: ReadonlyArray<readonly [string, Requirement]>,
  ) => ReadonlyMap<string, string>;
};

const oauth = { type: "oauth2" };
const key = (label: string) => ({ type: "secrets", label });
const requirement = (
  name: string,
  auth: Record<string, Auth>,
  cardinality: "one" | "many" = "many",
): Requirement => ({ definition: { name, auth }, cardinality });
const titles = (...entries: [string, Requirement][]) => [...requirementTitles(entries).entries()];

test("requirements of different services keep their service's name", () => {
  assert.deepEqual(
    titles(
      ["mail", requirement("Mail", { key: key("API key") })],
      ["calendar", requirement("Calendar", { oauth })],
    ),
    [
      ["mail", "Mail"],
      ["calendar", "Calendar"],
    ],
  );
});

test("one service declared for keys and for sign-ins names each by its methods", () => {
  assert.deepEqual(
    titles(
      ["vercel", requirement("Vercel", { apiKey: key("Access token") })],
      ["signIn", requirement("Vercel", { oauth })],
    ),
    [
      ["vercel", "Vercel · Access token"],
      ["signIn", "Vercel · Sign in"],
    ],
  );
  // Qualified sign-in labels drop the repeated service name too.
  assert.deepEqual(
    titles(
      ["us", requirement("Zoho", { oauthUs: oauth, oauthEu: oauth })],
      ["token", requirement("Zoho", { token: key("Token") })],
    ),
    [
      ["us", "Zoho · Sign in (US), Sign in (EU)"],
      ["token", "Zoho · Token"],
    ],
  );
});

test("one plain and one many() requirement of a service read apart", () => {
  const service = { key: key("API key") };
  assert.deepEqual(
    titles(
      ["primary", requirement("Account fixture", service, "one")],
      ["mailboxes", requirement("Account fixture", service, "many")],
    ),
    [
      ["primary", "Account fixture · Primary"],
      ["mailboxes", "Account fixture · Mailboxes"],
    ],
  );
});

test("requirements whose methods read alike are named by their slots", () => {
  assert.deepEqual(
    titles(
      ["shared", requirement("Contributed service", { key: key("Key") })],
      ["ordinary", requirement("Contributed service", { key: key("Key") })],
    ),
    [
      ["shared", "Contributed service · Shared"],
      ["ordinary", "Contributed service · Ordinary"],
    ],
  );
});

test("slots that read alike in words fall back to the declared slot", () => {
  const service = { key: key("API key") };
  const result = titles(
    ["apiKey", requirement("Service", service)],
    ["api_key", requirement("Service", service)],
  );
  assert.deepEqual(result, [
    ["apiKey", "Service · Api Key [apiKey]"],
    ["api_key", "Service · Api Key [api_key]"],
  ]);
  assert.equal(new Set(result.map(([, title]) => title)).size, result.length);
});

test("a service without a name gets no title", () => {
  assert.deepEqual(titles(["unnamed", requirement("  ", { oauth })]), []);
});
