import type { DataFiles } from "./binary-file-types.ts";
export async function resourceRange(
  adapter: DataFiles,
  path: string,
  offset: number,
  length: number,
  bytes: number,
) {
  const response = await fetch(adapter.getResourcePath(path), {
    headers: { range: `bytes=${offset}-${offset + length - 1}` },
    cache: "no-store",
  });
  if (
    response.status !== 206 ||
    response.headers.get("content-range") !== `bytes ${offset}-${offset + length - 1}/${bytes}`
  ) {
    await response.body?.cancel();
    throw new Error(
      "This device cannot read large local files in parts. Keep the file here and sync it from the Mac.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Local resource returned no byte stream");
  const output = new Uint8Array(length);
  let at = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (at + chunk.value.length > length)
        throw new Error("Local resource ignored its byte bound");
      output.set(chunk.value, at);
      at += chunk.value.length;
    }
    if (at !== length) throw new Error("Local resource range was truncated");
    return output;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
