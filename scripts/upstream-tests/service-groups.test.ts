import assert from "node:assert/strict";
import { test } from "node:test";

const dashboard = new URL(
  "../../.upstream/packages/ui/src/implementation/dashboard/",
  import.meta.url,
);
type Requirement = {
  readonly provider: string;
  readonly scope?: "app" | "user";
  readonly contributed?: boolean;
  readonly definition: { readonly name: string; readonly auth: Readonly<Record<string, object>> };
  readonly cardinality: "one" | "many";
};
type Entry = readonly [string, Requirement];
type Method = {
  slot: string;
  requirement: Requirement;
  method: string;
  label: string;
  tools?: string;
};
type Section = { requirement: string; method: string; title: string };
const { namesEveryRequirement, rowNote, serviceGroups, serviceMethods, servicePart, serviceTitle } =
  (await import(new URL("service-groups.ts", dashboard).href)) as {
    namesEveryRequirement: (
      tools: Record<string, string> | undefined,
      group: readonly Entry[],
    ) => boolean;
    rowNote: (
      group: readonly Entry[],
      slot: string,
      method: string,
      catalog: {
        readonly requirementTools?: Record<string, string>;
        readonly toolSections?: readonly Section[];
      },
    ) => string | undefined;
    serviceGroups: (entries: readonly Entry[], mergeable: (entry: Entry) => boolean) => Entry[][];
    serviceMethods: (methods: readonly Method[]) => Method[];
    servicePart: (group: readonly Entry[], slot: string) => string | undefined;
    serviceTitle: (group: readonly Entry[]) => string;
  };

const requirement = (
  provider: string,
  name: string,
  cardinality: "one" | "many" = "many",
): Requirement => ({ provider, definition: { name, auth: {} }, cardinality });
const sections = (entries: Entry[], mergeable: (entry: Entry) => boolean = () => true) =>
  serviceGroups(entries, mergeable).map((group) => ({
    title: serviceTitle(group),
    slots: group.map(([slot]) => slot),
  }));

test("a service declared twice, for a new sign-in beside a legacy one, is one section", () => {
  assert.deepEqual(
    sections([
      ["planetscaleSignIn", requirement("prv_sign_in", "PlanetScale")],
      ["planetscale", requirement("prv_legacy", "PlanetScale")],
    ]),
    [{ title: "PlanetScale", slots: ["planetscaleSignIn", "planetscale"] }],
  );
});

test("a name that opens with the service's name joins it, whichever is declared first", () => {
  assert.deepEqual(
    sections([
      ["aws", requirement("prv_aws", "AWS")],
      ["identityCenter", requirement("prv_ic", "AWS IAM Identity Center")],
      ["signIn", requirement("prv_mcp", "GitLab MCP")],
      ["gitlab", requirement("prv_gitlab", "GitLab")],
    ]),
    [
      { title: "AWS", slots: ["aws", "identityCenter"] },
      { title: "GitLab", slots: ["signIn", "gitlab"] },
    ],
  );
});

test("a name that only starts with the same letters is another service", () => {
  assert.deepEqual(
    sections([
      ["mail", requirement("prv_mail", "Mail")],
      ["mailchimp", requirement("prv_chimp", "Mailchimp")],
    ]),
    [
      { title: "Mail", slots: ["mail"] },
      { title: "Mailchimp", slots: ["mailchimp"] },
    ],
  );
});

test("roles of one provider keep their sections, so an account is never listed twice", () => {
  assert.deepEqual(
    sections([
      ["inbox", requirement("prv_mail", "Mail")],
      ["archive", requirement("prv_mail", "Mail")],
    ]),
    [
      { title: "Mail", slots: ["inbox"] },
      { title: "Mail", slots: ["archive"] },
    ],
  );
});

test("a requirement that takes one account keeps its own section", () => {
  assert.deepEqual(
    sections([
      ["primary", requirement("prv_a", "Service")],
      ["backup", requirement("prv_b", "Service", "one")],
    ]),
    [
      { title: "Service", slots: ["primary"] },
      { title: "Service", slots: ["backup"] },
    ],
  );
});

test("a requirement the tab shows differently stays apart and the rest keep their order", () => {
  assert.deepEqual(
    sections(
      [
        ["calendar", requirement("prv_cal", "Calendar")],
        ["rest", requirement("prv_rest", "Neon")],
        ["managed", requirement("prv_managed", "Neon")],
        ["mcp", requirement("prv_mcp", "Neon MCP")],
      ],
      ([slot]) => slot !== "managed",
    ),
    [
      { title: "Calendar", slots: ["calendar"] },
      { title: "Neon", slots: ["rest", "mcp"] },
      { title: "Neon", slots: ["managed"] },
    ],
  );
});

test("the connect menu lists each method once, naming its requirement only where labels meet", () => {
  const signIn = requirement("prv_sign_in", "PlanetScale");
  const legacy = requirement("prv_legacy", "PlanetScale");
  const eu = requirement("prv_eu", "Contentful (EU)");
  const us = requirement("prv_us", "Contentful");
  const menu = (methods: Method[]) =>
    serviceMethods(methods).map((entry) => [entry.slot, entry.method, entry.label]);
  // The legacy OAuth reads like the new sign-in, so the earlier declaration's stays.
  assert.deepEqual(
    menu([
      {
        slot: "planetscaleSignIn",
        requirement: signIn,
        method: "signIn",
        label: "Sign in with PlanetScale",
      },
      {
        slot: "planetscale",
        requirement: legacy,
        method: "oauth2",
        label: "Sign in with PlanetScale",
      },
      { slot: "planetscale", requirement: legacy, method: "token", label: "Service token" },
    ]),
    [
      ["planetscaleSignIn", "signIn", "Sign in with PlanetScale"],
      ["planetscale", "token", "Service token"],
    ],
  );
  assert.deepEqual(
    menu([
      { slot: "contentful", requirement: us, method: "key", label: "API key" },
      { slot: "contentfulEu", requirement: eu, method: "key", label: "API key" },
    ]),
    [
      ["contentful", "key", "API key · Contentful"],
      ["contentfulEu", "key", "API key · Contentful (EU)"],
    ],
  );
});

test("requirements whose links different people may change keep their own sections", () => {
  const shared = { ...requirement("prv_a", "Service"), scope: "app" as const, contributed: true };
  const owned = { ...requirement("prv_b", "Service"), scope: "app" as const };
  assert.deepEqual(
    sections([
      ["shared", shared],
      ["owned", owned],
    ]),
    [
      { title: "Service", slots: ["shared"] },
      { title: "Service", slots: ["owned"] },
    ],
  );
});

test("a row names the part of its service it serves only where the parts' names differ", () => {
  const gitlab: Entry[] = [
    ["signIn", requirement("prv_mcp", "GitLab MCP")],
    ["gitlab", requirement("prv_rest", "GitLab")],
  ];
  assert.equal(servicePart(gitlab, "signIn"), "For GitLab MCP");
  assert.equal(servicePart(gitlab, "gitlab"), undefined);
  const planetscale: Entry[] = [
    ["planetscaleSignIn", requirement("prv_sign_in", "PlanetScale")],
    ["planetscale", requirement("prv_legacy", "PlanetScale")],
  ];
  assert.equal(servicePart(planetscale, "planetscale"), undefined);
});

test("a row says which declared tool sections it can't run, and only those of its service", () => {
  const group: Entry[] = [
    ["planetscaleSignIn", requirement("prv_sign_in", "PlanetScale")],
    ["planetscale", requirement("prv_legacy", "PlanetScale")],
  ];
  const toolSections: Section[] = [
    { requirement: "planetscale", method: "token", title: "PlanetScale service-token tools" },
    { requirement: "other", method: "key", title: "Other tools" },
  ];
  // A sign-in or a legacy OAuth account can't run the token tools; a token account can.
  assert.equal(
    rowNote(group, "planetscaleSignIn", "signIn", { toolSections }),
    "Can't run PlanetScale service-token tools.",
  );
  assert.equal(
    rowNote(group, "planetscale", "oauth2", { toolSections }),
    "Can't run PlanetScale service-token tools.",
  );
  assert.equal(rowNote(group, "planetscale", "token", { toolSections }), undefined);
  assert.equal(rowNote(group, "planetscaleSignIn", "signIn", {}), undefined);
});

test("a row says which other requirements' tools it can't run, only where all are named", () => {
  const clerk: Entry[] = [
    ["signIn", requirement("prv_mcp", "Clerk")],
    ["clerk", requirement("prv_key", "Clerk")],
  ];
  const requirementTools = { signIn: "Clerk MCP tools", clerk: "Clerk REST API tools" };
  assert.equal(namesEveryRequirement(requirementTools, clerk), true);
  assert.equal(
    rowNote(clerk, "signIn", "oauth", { requirementTools }),
    "Can't run Clerk REST API tools.",
  );
  assert.equal(
    rowNote(clerk, "clerk", "apiKey", { requirementTools }),
    "Can't run Clerk MCP tools.",
  );
  // A requirement the catalog doesn't name leaves every row without a claim.
  const partial = { signIn: "Clerk MCP tools" };
  assert.equal(namesEveryRequirement(partial, clerk), false);
  assert.equal(rowNote(clerk, "clerk", "apiKey", { requirementTools: partial }), undefined);
  // Requirements that run the same tools never limit each other.
  assert.equal(
    rowNote(clerk, "clerk", "apiKey", {
      requirementTools: { signIn: "Clerk tools", clerk: "Clerk tools" },
    }),
    undefined,
  );
});

test("named tools replace the part a row serves and join its tool sections in one sentence", () => {
  const gitlab: Entry[] = [
    ["signIn", requirement("prv_mcp", "GitLab MCP")],
    ["gitlab", requirement("prv_rest", "GitLab")],
  ];
  const requirementTools = { signIn: "GitLab MCP tools", gitlab: "GitLab REST API tools" };
  const toolSections: Section[] = [
    { requirement: "gitlab", method: "token", title: "GitLab admin tools" },
  ];
  // Without named tools the MCP row names its part; with them it says what it can't run instead.
  assert.equal(rowNote(gitlab, "signIn", "mcp", {}), "For GitLab MCP");
  assert.equal(
    rowNote(gitlab, "signIn", "mcp", { requirementTools, toolSections }),
    "Can't run GitLab REST API tools or GitLab admin tools.",
  );
  // A part named after the section still says only what it can't run.
  assert.equal(
    rowNote(gitlab, "gitlab", "oauth", { requirementTools, toolSections }),
    "Can't run GitLab MCP tools or GitLab admin tools.",
  );
});

test("the connect menu keeps a repeated label whose requirement runs other catalog-named tools", () => {
  const signIn = requirement("prv_sign_in", "Service");
  const legacy = requirement("prv_legacy", "Service");
  // Both stay, under their own label: their tools tell them apart, not a repeated service name.
  const kept = serviceMethods([
    { slot: "signIn", requirement: signIn, method: "oauth", label: "Sign in", tools: "MCP tools" },
    { slot: "legacy", requirement: legacy, method: "oauth", label: "Sign in", tools: "REST tools" },
  ]).map(({ slot, label, tools }) => ({ slot, label, tools }));
  assert.deepEqual(kept, [
    { slot: "signIn", label: "Sign in", tools: "MCP tools" },
    { slot: "legacy", label: "Sign in", tools: "REST tools" },
  ]);
});
