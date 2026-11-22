/**
 * The gateway's node state is its tailnet identity, so it is sealed at rest under a key derived
 * from the pool's signing key, bound to its route, and never logged. A rotation keeps it readable
 * through the previous key, and the caller reseals it under the current one, so rotating never
 * signs the device out.
 */
export interface SealedRouteState {
  iv: number[];
  bytes: number[];
}

const encoder = new TextEncoder();
async function key(secret: string, usage: "encrypt" | "decrypt") {
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: encoder.encode("route-state-v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

export async function sealRouteState(
  secret: string,
  routeId: string,
  state: string,
): Promise<SealedRouteState> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(routeId) },
    await key(secret, "encrypt"),
    encoder.encode(state),
  );
  return { iv: [...iv], bytes: [...new Uint8Array(bytes)] };
}

export async function openRouteState(
  secret: string,
  routeId: string,
  sealed: SealedRouteState,
  previous?: string,
): Promise<{ state: string; reseal: boolean }> {
  try {
    const bytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(sealed.iv), additionalData: encoder.encode(routeId) },
      await key(secret, "decrypt"),
      new Uint8Array(sealed.bytes),
    );
    return { state: new TextDecoder().decode(bytes), reseal: false };
  } catch (error) {
    if (previous === undefined) throw error;
    return { state: (await openRouteState(previous, routeId, sealed)).state, reseal: true };
  }
}
