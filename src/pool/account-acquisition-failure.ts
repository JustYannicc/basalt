import { BackendFailure, ControlFailure, HomeTransportFailure } from "./json.ts";
import type { AcquisitionReceipt } from "./account-acquisition-contract.ts";

class AcquisitionFailure extends Error {
  readonly receipt: AcquisitionReceipt;
  constructor(receipt: AcquisitionReceipt) {
    super("Account acquisition step unavailable");
    this.receipt = receipt;
  }
}
export const invalidSignInCode = () =>
  new AcquisitionFailure({ phase: "oauth_callback", errorClass: "invalid_code", retryable: true });
export function acquisitionReceipt(error: unknown): AcquisitionReceipt {
  if (error instanceof AcquisitionFailure) return error.receipt;
  return {
    phase: "request",
    errorClass: error instanceof ControlFailure ? "invalid_response" : "internal",
    retryable: true,
  };
}
export async function acquisitionStep<A>(
  phase: AcquisitionReceipt["phase"],
  call: () => Promise<A>,
): Promise<A> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof AcquisitionFailure) throw error;
    const errorClass =
      error instanceof HomeTransportFailure
        ? error.errorClass
        : error instanceof BackendFailure
          ? error.backendStatus >= 500 || error.backendStatus === 429
            ? "home_unavailable"
            : "home_rejected"
          : error instanceof ControlFailure
            ? error.status === 404
              ? "home_rejected"
              : "invalid_response"
            : error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name)
              ? "timeout"
              : "internal";
    throw new AcquisitionFailure({ phase, errorClass, retryable: errorClass !== "home_rejected" });
  }
}
