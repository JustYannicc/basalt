const load = (path: string) => import(new URL(`../../.upstream/${path}`, import.meta.url).href);

export const { AccountListReads } = (await load(
  "apps/hosted/server/src/implementation/account-list-reads.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/account-list-reads.ts");

export const sdk = (await load(
  "packages/sdk/src/core.ts",
)) as typeof import("../../.upstream/packages/sdk/src/core.ts");
export const authorization = (await load(
  "packages/authorization/src/index.ts",
)) as typeof import("../../.upstream/packages/authorization/src/index.ts");
export const host = (await load(
  "packages/apps/src/host.ts",
)) as typeof import("../../.upstream/packages/apps/src/host.ts");
export const policy = (await load(
  "apps/hosted/server/src/implementation/provider-account-policy.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/provider-account-policy.ts");
export const methods = (await load(
  "apps/hosted/server/src/implementation/provider-account-methods.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/provider-account-methods.ts");
export const destinations = (await load(
  "apps/hosted/server/src/implementation/provider-account-destination.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/provider-account-destination.ts");
export const { providerAccountContext } = (await load(
  "apps/hosted/server/src/implementation/provider-account-context.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/provider-account-context.ts");
export const resources = (await load(
  "apps/hosted/server/src/implementation/resource-policy.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/resource-policy.ts");
export const installs = (await load(
  "apps/hosted/server/src/implementation/service-install-records.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/service-install-records.ts");
export const { providers } = (await load(
  "apps/hosted/server/src/implementation/pool-provider-definitions.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/pool-provider-definitions.ts");
export const { currentOwner } = (await load(
  "apps/hosted/server/src/implementation/access.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/access.ts");
export const { CurrentAuthorization } = (await load(
  "apps/hosted/server/src/contracts/authorization.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/contracts/authorization.ts");
export const { HostedCatalog } = (await load(
  "apps/hosted/server/src/contracts/catalog.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/contracts/catalog.ts");
export const { HostedExecutor } = (await load(
  "apps/hosted/server/src/contracts/executor.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/contracts/executor.ts");
export const { GroupDatabase } = (await load(
  "apps/hosted/server/src/contracts/groups.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/contracts/groups.ts");
export const { CurrentOrganization, OrganizationId, organizationOwner } = (await load(
  "apps/hosted/server/src/contracts/organization.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/contracts/organization.ts");
export const { CurrentUserId } = (await load(
  "apps/hosted/server/src/contracts/auth.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/contracts/auth.ts");
export type {
  App,
  AppId,
  Executor,
  ProviderDefinition,
} from "../../.upstream/packages/sdk/src/core.ts";
export type { ProviderAccountDestination } from "../../.upstream/apps/hosted/server/src/contracts/provider-account-policy.ts";
