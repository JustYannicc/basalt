/** Readiness can outlive a request even when the eventual port fetch honors its signal. */
export function homeResponse(read: () => Promise<Response>, signal?: AbortSignal | null): Promise<Response> {
  signal?.throwIfAborted();
  const response = read();
  if (!signal) return response;
  return new Promise<Response>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(signal.reason); };
    signal.addEventListener("abort", aborted, { once: true });
    response.then((value) => {
      signal.removeEventListener("abort", aborted);
      if (signal.aborted) {
        void value.body?.cancel().catch(() => {});
        reject(signal.reason);
      } else resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", aborted);
      reject(error);
    });
    if (signal.aborted) aborted();
  });
}
