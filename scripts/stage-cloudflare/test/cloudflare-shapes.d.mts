// Types for cloudflare-shapes.mjs, so TypeScript regressions serve the same recorded bodies.
type Body = Record<string, unknown>;
export declare const envelope: (result: unknown) => Body;
export declare const listPage: (
  result: readonly unknown[],
  options?: { page?: number; totalPages?: number },
) => Body;
export declare const refusalBody: (errors: readonly { code: number; message: string }[]) => Body;
export declare const application: (fields: { id: string; name: string; image?: string }) => Body;
export declare const script: (id: string) => Body;
export declare const namespace: (fields: {
  id: string;
  className: string;
  script: string;
  name?: string;
}) => Body;
export declare const hyperdrive: (fields: { id: string; name: string }) => Body;
export declare const certificate: (fields: { id: string; name: string }) => Body;
export declare const settings: (text?: Record<string, string>) => Body;
export declare const subdomain: (name: string) => Body;
export declare const registryCredentials: () => Body;
export declare const catalog: (repositories: readonly string[]) => { repositories: readonly string[] };
export declare const tagList: (
  name: string,
  tags: readonly string[] | null,
) => { name: string; tags: readonly string[] | null };
export declare const imageIndex: (digests: readonly string[]) => Body;
