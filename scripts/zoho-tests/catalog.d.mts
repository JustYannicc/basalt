export const ZOHO_SNAPSHOT_PATH: string;
export const ZOHO_SNAPSHOT_SHA256: string;
export const ZOHO_CLIENT_ID: string;
export const ZOHO_CLIENT_SECRET: string;
export const ZOHO_SCOPES: readonly string[];

export interface ZohoFileDigest {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ZohoCatalogSource {
  readonly packageName: string;
  readonly snapshot: {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly files: readonly ZohoFileDigest[];
  };
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly payload: {
    readonly sha256: string;
    readonly files: readonly ZohoFileDigest[];
  };
  readonly officialRegions: readonly {
    readonly id: string;
    readonly accountsOrigin: string;
    readonly apiOrigin: string;
  }[];
  readonly hostedRegionalClients: readonly string[];
  readonly sdkAdaptation: {
    readonly path: string;
    readonly from: string;
    readonly to: string;
    readonly occurrences: number;
  };
  readonly loopbackOriginRewrites: readonly {
    readonly path: string;
    readonly from: string;
    readonly to: string;
    readonly count: number;
  }[];
  readonly providerOrigin: string;
  readonly scopes: readonly string[];
}

export function loadZohoCatalogSource(input: {
  readonly snapshotPath?: string;
  readonly expectedSnapshotSha256?: string;
  readonly providerOrigin: string;
  readonly upstream: string;
  readonly hostedDefinitions: readonly unknown[];
}): Promise<ZohoCatalogSource>;

export function localZohoOAuthDefinition(
  hostedDefinitions: readonly unknown[],
  providerOrigin: string,
): {
  readonly definition: unknown;
  readonly adaptation: Readonly<Record<string, unknown>>;
};
