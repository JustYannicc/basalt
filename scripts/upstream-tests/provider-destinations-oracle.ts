// Frozen per-requirement rules from the carry's base, used only as an equality oracle.
import { Crypto, Effect, Option } from "effect";
import {
  authorization,
  sdk,
  host,
  resources,
  installs,
  policy,
  methods,
  providers,
  CurrentAuthorization,
  HostedCatalog,
  HostedExecutor,
  currentOwner,
  type App,
  type ProviderAccountDestination,
} from "./provider-destinations-modules.ts";
const { permittedAppIds, permitsAction } = authorization;
const { StorageError, identifyProvider, AccountAcquisitionConfiguration } = sdk;
const { providerDeclaration } = host;
const {
  applicationAccesses,
  currentResourceAuthority,
  policyDatabase,
  visibleApps,
  requireCurrentAppAccess,
} = resources;
const { recordedServiceInstalls } = installs;
const { registeredPool } = policy;
const { providerAccountMethods } = methods;
export const oldDestination = (app: App, requirement: string) =>
  Effect.gen(function* () {
    const unavailable = (reason: string): ProviderAccountDestination => ({
      kind: "unavailable",
      reason,
    });
    const slot = app.requirements.accounts[requirement];
    const lab = slot?.definition.family?.id;
    if (slot === undefined || lab === undefined || !Object.hasOwn(providers, lab))
      return unavailable("This retained account must keep its existing link until adoption.");
    const definition = yield* providerDeclaration(providers[lab as keyof typeof providers]);
    const identified = yield* identifyProvider(definition, yield* Crypto.Crypto);
    if (slot.provider !== identified.identity && slot.provider !== identified.legacy)
      return unavailable("No provider app is registered for this account requirement.");
    const catalog = yield* Effect.serviceOption(HostedCatalog);
    if (Option.isNone(catalog)) return unavailable("The provider catalog is unavailable.");
    const entries = yield* catalog.value.list.pipe(Effect.catch(() => Effect.succeed([])));
    const entry = entries.find((entry) => entry.id === `provider-${lab}`);
    if (entry === undefined)
      return unavailable("This provider app is not available in the catalog.");
    const policy = yield* CurrentAuthorization;
    if (!permitsAction(policy, "manage"))
      return unavailable("Account management access is required.");
    const executor = yield* Effect.flatten(HostedExecutor);
    const owner = yield* currentOwner;
    const apps = yield* executor.apps
      .list({ owner, ids: permittedAppIds(policy) })
      .pipe(Effect.flatMap(visibleApps));
    const recorded = yield* recordedServiceInstalls(yield* policyDatabase, apps);
    const access = new Map(
      (yield* applicationAccesses(
        apps.map((candidate) => candidate.id),
        yield* currentResourceAuthority,
      )).map((entry) => [entry.app, entry]),
    );
    const destinations = apps.flatMap((candidate) => {
      const service = recorded.get(candidate.id);
      const installed =
        service === undefined
          ? candidate.copiedFrom?.name === entry.package
          : service.id === (entry.service?.id ?? entry.package);
      if (!installed || candidate.activeVersion === null) return [];
      return Object.entries(candidate.requirements.accounts).flatMap(([requirement, required]) =>
        required.provider === slot.provider &&
        required.scope === "app" &&
        (required.contributed
          ? access.get(candidate.id)?.canUse
          : access.get(candidate.id)?.canManage)
          ? [{ app: candidate.id, name: candidate.name, requirement }]
          : [],
      );
    });
    return destinations.length === 0
      ? { kind: "catalog" as const, entry: entry.id }
      : { kind: "apps" as const, apps: destinations };
  }).pipe(Effect.mapError(() => new StorageError()));

const oldIdentity = (app: App) =>
  Effect.gen(function* () {
    const catalog = yield* Effect.serviceOption(HostedCatalog);
    if (app.activeVersion === null || Option.isNone(catalog)) return null;
    const entries = yield* catalog.value.list.pipe(Effect.catch(() => Effect.succeed([])));
    const installed = (yield* recordedServiceInstalls(yield* policyDatabase, [app])).get(app.id);
    const crypto = yield* Crypto.Crypto;
    const matches = yield* Effect.forEach(
      Object.entries(app.requirements.accounts),
      ([requirement, slot]) =>
        Effect.gen(function* () {
          const family = slot.definition.family?.id;
          if (family === undefined || slot.scope !== "app" || !Object.hasOwn(providers, family))
            return undefined;
          const entry = entries.find((entry) => entry.id === `provider-${family}`);
          if (
            entry === undefined ||
            (installed === undefined
              ? app.copiedFrom?.name !== entry.package
              : installed.id !== (entry.service?.id ?? entry.package))
          )
            return undefined;
          const definition = yield* providerDeclaration(
            providers[family as keyof typeof providers],
          );
          const id = yield* identifyProvider(definition, crypto);
          return slot.provider === id.identity || slot.provider === id.legacy
            ? { family, requirement }
            : undefined;
        }),
    );
    const found = matches.filter((match) => match !== undefined);
    const family = found[0]?.family;
    return family === undefined || found.some((match) => match.family !== family)
      ? null
      : { family, requirements: found.map((match) => match.requirement) };
  }).pipe(Effect.mapError(() => new StorageError()));

const oldPolicies = (app: App, identity?: Effect.Success<ReturnType<typeof oldIdentity>>) =>
  Effect.gen(function* () {
    const pool = yield* registeredPool(app.id);
    const { access } = yield* requireCurrentAppAccess(app.id, "read");
    const manage = permitsAction(yield* CurrentAuthorization, "manage");
    const { registrations } = yield* AccountAcquisitionConfiguration;
    const providerApp = pool ? null : identity === undefined ? yield* oldIdentity(app) : identity;
    return yield* Effect.forEach(Object.entries(app.requirements.accounts), ([requirement, slot]) =>
      Effect.gen(function* () {
        const allowed =
          manage &&
          (slot.scope === "user" || (slot.contributed ? access.canUse : access.canManage));
        const automatic = Object.values(slot.definition.auth).every(
          (method) => method.type === "secrets" && method.provisioned === true,
        );
        const destination = yield* oldDestination(app, requirement);
        const importMethod =
          slot.definition.family?.id === "openai"
            ? "codex"
            : slot.definition.family?.id === "anthropic"
              ? "claude"
              : undefined;
        return {
          requirement,
          canConnect: allowed && !pool && !automatic,
          canSelect: allowed && !automatic && !(pool && requirement === "subscriptions"),
          importMethods:
            allowed &&
            !pool &&
            providerApp?.requirements.includes(requirement) &&
            importMethod !== undefined &&
            registrations.some(
              (entry) =>
                entry.current &&
                entry.provider === slot.provider &&
                entry.method === importMethod &&
                entry.driver.importCredentials !== undefined,
            )
              ? [importMethod]
              : [],
          destination,
        };
      }),
    );
  });

export const oldMethods = (app: App) =>
  Effect.gen(function* () {
    const methods = yield* providerAccountMethods(app);
    const providerApp = (yield* registeredPool(app.id)) ? null : yield* oldIdentity(app);
    const connections = yield* oldPolicies(app, providerApp);
    return {
      ...methods,
      providerApp,
      connections: connections.map((policy) => ({
        ...policy,
        canConnect:
          policy.canConnect &&
          Object.keys(app.requirements.accounts[policy.requirement]!.definition.auth).some(
            (method) =>
              !methods.unavailable.some(
                (entry) => entry.requirement === policy.requirement && entry.method === method,
              ),
          ),
      })),
    };
  });
