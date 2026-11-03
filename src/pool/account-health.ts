import { subscriptionFailure } from "../../apps/pool/account-health.ts";
import { identityOf } from "../../apps/pool/sign-in.ts";
import { acquisitionAssertion } from "./account-acquisition-assertion.ts";
import { readCredentialAccount } from "./account-check.ts";
import type { HomeClient } from "./control.ts";
import { homeReferences } from "./home-references.ts";
import { json, rows, text } from "./json.ts";
import providers from "./providers.json" with { type: "json" };
import { hasUsageLimits, type QuotaCollection } from "./quota-collection.ts";
import { publicQuotaObservation } from "./quota-observation-public.ts";
import { quotaObservation } from "./quota-observation.ts";

/** Health reads share the collection cap, but never hold the sign-in/attribution queue. */
export async function nativeAccountHealth(
  request: Request,
  input: {
    client: HomeClient;
    collection: QuotaCollection;
    signingKey: string;
    previousSigningKey?: string;
    now?: () => number;
  },
): Promise<Response | undefined> {
  if (request.method !== "POST") return undefined;
  let value;
  try {
    value = await acquisitionAssertion(
      request,
      input.signingKey,
      input.previousSigningKey,
      input.now?.(),
    );
  } catch {
    return json({ error: "acquisition_forbidden" }, 403);
  }
  if (value.action !== "check" && value.action !== "observe") return undefined;
  try {
    const provider = text(value.provider),
      reference = text(value.reference);
    if (!provider || !reference) throw new Error("Missing account binding");
    const ids = homeReferences(reference);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]);
    const files = rows((await input.client.data("/credentials", { signal })).files);
    if (
      !ids.every((id) =>
        files.some(
          (file) => file.id === id && (text(file.provider) ?? text(file.type)) === provider,
        ),
      )
    )
      return json({ failure: "unauthorized" });
    if (value.action === "observe") {
      // The alarm already queued linked credentials. Unlinked bindings use the same capped reader.
      if (!ids.every((id) => hasUsageLimits(files.find((file) => file.id === id)!))) return json({ result: null });
      const readings = await Promise.all(ids.map((id) => input.collection.read(id, signal, false)));
      const reading = readings[0];
      // An account whose collected windows are all unlimited has no usage to report (audit #10).
      const limited = reading != null && hasUsageLimits(files.find((file) => file.id === ids[0])!, reading);
      return json({ result: readings.length === 1 && limited
        ? publicQuotaObservation(quotaObservation(reading)) : null });
    }
    const checked = await Promise.all(
      ids.map((id) => readCredentialAccount(input.client, input.collection, id, signal, files)),
    );
    const failure = checked
      .map(({ account }) => subscriptionFailure(account, input.now?.()))
      .find((reason) => reason !== null);
    if (failure) return json({ failure });
    const first = checked[0]!;
    const identity =
      first.account.label === first.account.id ? {} : identityOf(first.account, providers);
    const observation =
      checked.length === 1 && first.quota !== null
        ? publicQuotaObservation(quotaObservation(first.quota))
        : null;
    return json({
      result: { accountInfo: identity, ...(observation === null ? {} : { observation }) },
    });
  } catch {
    return json({ failure: "unavailable" });
  }
}
