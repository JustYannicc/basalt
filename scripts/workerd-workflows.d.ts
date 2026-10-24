/** Workerd constructor matching the pinned @cloudflare/workers-types declaration. */
declare module "cloudflare:workflows" {
  export class NonRetryableError extends Error {
    constructor(message: string, name?: string);
  }
}
