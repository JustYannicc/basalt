import { isCloudflareApiError } from "../stage-cloudflare/api.mjs";

/** An error whose message this stage wrote itself, from names and counts only: it may be printed. */
export class StageError extends Error {}

/**
 * What a run may print for an error. Only this stage's and the account API's own messages; a
 * runtime error such as undici's names its cause's host (the account's workers.dev subdomain).
 */
export function publicMessage(error) {
  if (error instanceof StageError || isCloudflareApiError(error)) return error.message;
  const kind = /^[A-Za-z]{1,40}$/u.test(error?.name ?? "") ? error.name : "error";
  return `The run stopped on an unexpected ${kind}; its detail stays private`;
}
