import { subscriptionFailure } from "../../apps/pool/account-health.ts";
import { identityOf } from "./account-identity.ts";
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
  if (
    value.action !== "check" &&
    value.action !== "observe" &&
    value.action !== "verify-retirement-reference"
  )
    return undefined;
  try {
    const provider = text(value.provider),
      reference = text(value.reference);
    if (!provider || !reference) throw new Error("Missing account binding");
    const ids = homeReferences(reference);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]);
    const files = rows((await input.client.data("/credentials", { signal })).files);
    if (value.action === "verify-retirement-reference") {
      const matches = files.filter((file) => file.id === reference);
      const verified =
        ids.length === 1 &&
        ids[0] === reference &&
        matches.length === 1 &&
        (text(matches[0]!.provider) ?? text(matches[0]!.type)) === provider &&
        matches[0]!.deleted_at == null &&
        matches[0]!.deleted !== true;
      return json({
        verified,
        code: verified ? "retirement_reference_verified" : "retirement_reference_unavailable",
      });
    }
    if (
      !ids.every((id) =>
        files.some(
          (file) => file.id === id && (text(file.provider) ?? text(file.type)) === provider,
        ),
      )
    )
      return json({ failure: "unauthorized" });
    if (value.action === "observe") {
      // Await this pass outside the attribution queue, including for unlinked bindings.
      if (!ids.every((id) => hasUsageLimits(files.find((file) => file.id === id)!)))
        return json({ result: null });
      const readings = await Promise.all(ids.map((id) => input.collection.read(id, signal, true)));
      const reading = readings[0];
      if (readings.length === 1 && reading != null) {
        const observation = quotaObservation(reading);
        // A first failed collection has no reading to carry its failure metadata.
        if (observation.observedAt === null && observation.collection.status === "failed")
          return json({
            failure:
              observation.collection.errorCode === "UPSTREAM_RATE_LIMITED"
                ? "rate_limited"
                : "unavailable",
          });
      }
      // Unlimited windows are reported as unlimited; whether a row shows them is the row's choice.
      return json({
        result:
          readings.length === 1 && reading != null
            ? publicQuotaObservation(quotaObservation(reading))
            : null,
      });
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
