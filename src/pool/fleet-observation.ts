export const poolObservationPermission = "cfd39eebc07c4e3ea849e4b3d2644637";

export function poolObservationTokenProps(accountId: string, stage: string) {
  return {
    accountId,
    name: `basalt-${stage}-pool-provider-observation`,
    policies: [
      {
        effect: "allow" as const,
        permissionGroups: [{ id: poolObservationPermission }],
        resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
      },
    ],
  };
}
