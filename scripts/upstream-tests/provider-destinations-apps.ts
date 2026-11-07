import { Crypto, Effect, Schema, SchemaIssue } from "effect";
import { providers as poolProviders } from "../../src/pool/provider-accounts/definitions.ts";
import { requirements as poolRequirements } from "../../apps/pool/requirements.ts";
import {
  host,
  OrganizationId,
  organizationOwner,
  providers,
  sdk,
  type App,
  type ProviderDefinition,
} from "./provider-destinations-modules.ts";
type Slot = App["requirements"]["accounts"][string];

export const providerFixtureApps = (pool: boolean, shape: "mixed" | "literal" = "mixed") =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const organization = OrganizationId.make("destination-fixture");
    const owner = organizationOwner(organization);
    const definitions = new Map<
      string,
      { definition: ProviderDefinition; identity: string; legacy: string }
    >();
    const families =
      shape === "literal"
        ? Object.keys(poolProviders)
        : ["openai", "anthropic", "gemini", "vertex", "openrouter", "xai", "qwen", "iflow"];
    for (const family of families) {
      const provider =
        shape === "literal"
          ? poolProviders[family as keyof typeof poolProviders]
          : providers[family as keyof typeof providers];
      const definition = yield* host.providerDeclaration(provider);
      const identity = yield* sdk.identifyProvider(definition, crypto);
      definitions.set(family, { ...identity, definition });
    }
    const slot = (
      family: string,
      scope: "app" | "user" = "app",
      contributed = false,
      legacy = false,
    ): Slot => {
      const found = definitions.get(family)!;
      return {
        definition: found.definition,
        provider: sdk.ProviderId.make(legacy ? found.legacy : found.identity),
        scope,
        contributed,
        cardinality: "many",
      };
    };
    let accounts: Record<string, Slot> = {
      openai: slot("openai", "app", true),
      anthropic: slot("anthropic", "app", true),
      gemini: slot("gemini"),
      vertex: slot("vertex"),
      openrouter: slot("openrouter"),
      xai: slot("xai"),
      qwen: slot("qwen"),
      iflow: slot("iflow"),
      personal: slot("openai", "user"),
      legacy: slot("anthropic", "app", false, true),
      duplicate: slot("openai"),
      subscriptions: { ...slot("openai"), definition: { name: "Retained", auth: {} } },
      automatic: {
        ...slot("openai", "user"),
        definition: {
          name: "Automatic",
          auth: {
            key: {
              type: "secrets",
              label: "Provisioned key",
              provisioned: true,
              fields: { type: "object" },
            },
          },
        },
      },
      unknown: {
        ...slot("openai"),
        definition: {
          ...definitions.get("openai")!.definition,
          family: { id: "unknown", name: "Unknown", methods: {} },
        },
      },
      changed: { ...slot("openai"), provider: sdk.ProviderId.make("prv_changed") },
    };
    if (shape === "literal") {
      const definition = yield* host.providerDeclaration(poolRequirements.app.accounts.pool);
      accounts = {
        pool: {
          definition,
          provider: (yield* sdk.identifyProvider(definition, crypto)).identity,
          scope: "app",
          cardinality: "one",
          contributed: false,
        },
        ...Object.fromEntries(
          families.map((family) => [
            family,
            {
              ...slot(family, "app", true),
              capabilities: ["model-inference"],
            },
          ]),
        ),
      };
    }
    const decodeApp = (value: unknown): App => {
      const result = Schema.decodeUnknownResult(sdk.AppFields)(value);
      if (result._tag === "Failure")
        throw new Error(SchemaIssue.makeFormatterDefault()(result.failure.issue));
      return result.success;
    };
    const makeApp = (id: string, required: Record<string, Slot>, packageName?: string): App =>
      decodeApp({
        id: sdk.AppId.make(id),
        slug: sdk.AppSlug.make(id.replaceAll("_", "-")),
        code: sdk.AppCodeId.make(`code_${id}`),
        repository: null,
        owner,
        name: id,
        activeVersion: sdk.VersionId.make(`dpl_${id}`),
        copiedFrom:
          packageName === undefined
            ? null
            : { reference: packageName, name: packageName, commit: null },
        requirements: { accounts: required },
        createdAt: new Date(0),
      });
    let app = makeApp("app_pool", accounts);
    const listed = [...definitions.keys()].flatMap((family) => [
      makeApp(
        `app_${family}`,
        {
          account: slot(family),
          contribution: slot(family, "app", true),
          user: slot(family, "user"),
          legacy: slot(family, "app", false, true),
        },
        `fixture-${family}`,
      ),
      makeApp(`app_hidden_${family}`, { account: slot(family) }, `fixture-${family}`),
    ]);
    const inactive = { ...listed[0]!, id: sdk.AppId.make("app_inactive"), activeVersion: null };
    listed.push(inactive, makeApp("app_recorded", { account: slot("openai") }, "unrelated-copy"));
    // The non-pool variant is itself a provider app, with importable and unavailable methods.
    if (!pool) {
      app = {
        ...app,
        requirements: {
          accounts: {
            primary: slot("openai"),
            legacy: slot("openai", "app", true, true),
            personal: slot("openai", "user"),
          },
        },
        copiedFrom: { reference: "fixture-openai", name: "fixture-openai", commit: null },
      };
    }
    return { app, listed, accounts, definitions, organization, owner };
  });
