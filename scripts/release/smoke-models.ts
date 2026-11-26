/**
 * Which model a production deploy proves the pool with. Before the apply, a pool whose accounts for
 * one model have no quota left refuses that model's turn; nothing has changed yet, so the next
 * acceptance model is tried. Any other failure is the answer.
 */
import { acceptanceModels } from "./acceptance.ts";
import { HttpStatusFailure } from "../pool-acceptance/types.ts";

/**
 * The refusals that mean "this pool has no quota for the model", and only these. Home decides them
 * before dispatch, and the pool's node relays each as HTTP 429 under the generic
 * `rate_limit_error` / `rate_limit_exceeded`, with Home's code as the message's `<code>: ` prefix:
 * - `usage_credit_policy_denied`: no account the pool may fund has funding for the model.
 * - `model_cooldown`: every credential for the model is cooling down, after its provider's limit or
 *   its refusal of them (the node cools a credential on a provider's 401, 402, 403 or 404 too).
 * The node's own selector sends `model_cooldown` as `error.code` itself. Any other 429 (the pool's
 * per-user cap, a credential's concurrency, a provider's own limit) is not quota. Either way the
 * pool cannot serve that model now, which is all the choice before the apply needs; after the apply
 * nothing falls back (`smokeAfterApply`).
 */
export const quotaRefusals = ["usage_credit_policy_denied", "model_cooldown"] as const;
type QuotaRefusal = (typeof quotaRefusals)[number];
const isQuotaCode = (code: string | undefined): code is QuotaRefusal =>
  quotaRefusals.some((quota) => quota === code);

export function quotaRefusal(error: unknown): QuotaRefusal | undefined {
  if (!(error instanceof HttpStatusFailure) || error.status !== 429 || !error.refusal) return;
  const { code, type, prefix } = error.refusal;
  if (code === "model_cooldown") return code;
  if (type === "rate_limit_error" && code === "rate_limit_exceeded" && isQuotaCode(prefix))
    return prefix;
  return undefined;
}

/** The configured model first, then the repository's other acceptance models in their order. */
export const smokeModels = (first: string) => [
  first,
  ...acceptanceModels.filter((model) => model !== first),
];

/** One turn's failure in public words: the pool's refusal code, else its status, else the class. */
export function turnFailure(error: unknown) {
  if (!(error instanceof HttpStatusFailure))
    return error instanceof Error ? error.constructor.name : "failure";
  const { code, prefix } = error.refusal ?? {};
  const reason = prefix ?? code;
  return reason ? `${reason}, HTTP ${error.status}` : `HTTP ${error.status}`;
}

/**
 * Tries each model in order until one serves a turn. It moves on only when the pool refused the
 * turn for quota; any other failure ends the tries. `tried` names every model that did not serve.
 */
export async function firstServing(
  models: readonly string[],
  send: (model: string) => Promise<unknown>,
): Promise<{ model?: string; tried: string[] }> {
  const tried: string[] = [];
  for (const model of models) {
    try {
      await send(model);
      return { model, tried };
    } catch (error) {
      tried.push(`${model}: ${turnFailure(error)}`);
      if (!quotaRefusal(error)) break;
    }
  }
  return { tried };
}

/**
 * Before the apply: the model a deploy smokes with, or why it must stop with nothing applied. A
 * pool with no quota for any acceptance model would refuse the smoke after the apply too, and that
 * would roll a sound release back.
 */
export async function servedBeforeApply(
  models: readonly string[],
  send: (model: string) => Promise<unknown>,
): Promise<{ model: string; line: string } | { stop: string }> {
  const { model, tried } = await firstServing(models, send);
  if (!model)
    return {
      stop: `No acceptance model served a turn before the apply (${tried.join("; ")}); nothing applied`,
    };
  return {
    model,
    line: `Before the apply, ${model} served a turn${tried.length ? `; first ${tried.join("; ")}` : ""}.`,
  };
}

/**
 * After the apply: one turn on the model that served before it, and no other. That model was
 * served on the release before; a refusal now, quota-shaped or not, may be this release's doing
 * (a request the provider rejects cools every credential for the model, and the pool Worker writes
 * the funding policy), so it fails the smoke and the release is re-pointed back.
 */
export async function smokeAfterApply(
  served: string,
  send: (model: string) => Promise<unknown>,
): Promise<{ passed: true } | { passed: false; why: string }> {
  try {
    await send(served);
    return { passed: true };
  } catch (error) {
    return { passed: false, why: `${served}: ${turnFailure(error)}` };
  }
}
