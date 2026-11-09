export const nativePolicyReasons = [
  "envelope",
  "signature",
  "json",
  "identifier",
  "revision",
  "expiry",
  "account_count",
  "account_id",
  "duplicate_account",
  "lease_window",
] as const;
export type NativePolicyReason = (typeof nativePolicyReasons)[number];
export const isNativePolicyReason = (value: unknown): value is NativePolicyReason =>
  nativePolicyReasons.some((reason) => reason === value);

export const isNativePolicyLeaseMs = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= -60_000 && value <= 60_000;

/** Diagnostics share the install deadline and cannot replace the original refusal. */
export async function readNativePolicyReason(response: Response, signal: AbortSignal) {
  try {
    const reader = response.body?.getReader();
    if (!reader) return undefined;
    let detach = () => {};
    const read = async () => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (let count = 0; count <= 1024; count++) {
        const { value, done } = await reader.read();
        if (done) {
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const body: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
          );
          if (
            typeof body !== "object" ||
            body === null ||
            !("error" in body) ||
            (body.error !== "invalid_projection" && body.error !== "invalid_projection_framing") ||
            !("reason" in body) ||
            !isNativePolicyReason(body.reason)
          )
            return undefined;
          return {
            reason: body.reason,
            ...(body.reason === "lease_window" &&
            "leaseMs" in body &&
            isNativePolicyLeaseMs(body.leaseMs)
              ? { leaseMs: body.leaseMs }
              : {}),
          };
        }
        size += value.byteLength;
        if (size > 1024) return undefined;
        chunks.push(value);
      }
      return undefined;
    };
    try {
      const aborted = new Promise<undefined>((resolve) => {
        const abort = () => resolve(undefined);
        detach = () => signal.removeEventListener("abort", abort);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      return await Promise.race([aborted, read()]);
    } finally {
      detach();
      void reader.cancel().catch(() => {});
    }
  } catch {
    return undefined;
  }
}
