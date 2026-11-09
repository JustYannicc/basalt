import { PoolDependencyFailure, poolDependency } from "./dependency-failure.ts";
import { diagnosePoolFailure, unavailable } from "./json.ts";
import { policyPrefix, type NativeMembershipPolicy } from "./membership-contract.ts";
import { signEnvelope } from "./token.ts";
import { readNativePolicyReason } from "./native-policy-diagnostic.ts";

/** Only an exact signed policy acknowledgement can make native membership usable. */
export async function installNativePolicy(
  container: {
    getTcpPort(port: number): { fetch(input: string, init: RequestInit): Promise<Response> };
  },
  input: { signingKey: string; managementKey: string },
  policy: NativeMembershipPolicy,
): Promise<void> {
  const projection = await signEnvelope(input.signingKey, policyPrefix, policy);
  const signal = AbortSignal.timeout(2_000);
  const response = await poolDependency(
    "membership",
    container.getTcpPort(8318).fetch("http://pool/native-policy", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.managementKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ projection }),
      signal,
    }),
  );
  if (!response.ok) {
    const reason =
      response.status === 400 || response.status === 409
        ? await readNativePolicyReason(response, signal)
        : undefined;
    if (response.body && !response.body.locked)
      await poolDependency("membership", response.body.cancel());
    return unavailable({
      guard: "native_policy_install",
      failure: "response_status",
      backendStatus: response.status,
      ...(reason === undefined ? {} : { reason }),
    });
  }
  const body = await poolDependency("membership", response.text());
  let acknowledgement: unknown;
  try {
    acknowledgement = JSON.parse(body);
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    throw diagnosePoolFailure(new PoolDependencyFailure("membership", cause), {
      guard: "native_policy_install",
      failure: "invalid_body",
    });
  }
  if (
    typeof acknowledgement !== "object" ||
    acknowledgement === null ||
    !("installed" in acknowledgement) ||
    acknowledgement.installed !== true ||
    !("revision" in acknowledgement) ||
    acknowledgement.revision !== policy.revision
  )
    return unavailable({ guard: "native_policy_install", failure: "invalid_body" });
}
