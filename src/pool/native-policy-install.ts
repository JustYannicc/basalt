import { PoolDependencyFailure, poolDependency } from "./dependency-failure.ts";
import { unavailable } from "./json.ts";
import { policyPrefix, type NativeMembershipPolicy } from "./membership-contract.ts";
import { signEnvelope } from "./token.ts";

/** Only an exact signed policy acknowledgement can make native membership usable. */
export async function installNativePolicy(
  container: {
    getTcpPort(port: number): { fetch(input: string, init: RequestInit): Promise<Response> };
  },
  input: { signingKey: string; managementKey: string },
  policy: NativeMembershipPolicy,
): Promise<void> {
  const projection = await signEnvelope(input.signingKey, policyPrefix, policy);
  const response = await poolDependency(
    "membership",
    container.getTcpPort(8318).fetch("http://pool/native-policy", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.managementKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ projection }),
      signal: AbortSignal.timeout(2_000),
    }),
  );
  if (!response.ok) {
    if (response.body) await poolDependency("membership", response.body.cancel());
    return unavailable();
  }
  const body = await poolDependency("membership", response.text());
  let acknowledgement: unknown;
  try {
    acknowledgement = JSON.parse(body);
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    throw new PoolDependencyFailure("membership", cause);
  }
  if (
    typeof acknowledgement !== "object" ||
    acknowledgement === null ||
    !("installed" in acknowledgement) ||
    acknowledgement.installed !== true ||
    !("revision" in acknowledgement) ||
    acknowledgement.revision !== policy.revision
  )
    return unavailable();
}
