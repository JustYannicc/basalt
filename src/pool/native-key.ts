export interface SealedNativeKey {
  iv: number[];
  bytes: number[];
}

const encoder = new TextEncoder();
async function key(secret: string, usage: "encrypt" | "decrypt") {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(`native-computer:${secret}`));
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [usage]);
}
export async function sealNativeKey(
  secret: string,
  token: string,
  identity: string,
): Promise<SealedNativeKey> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(identity) },
    await key(secret, "encrypt"),
    encoder.encode(token),
  );
  return { iv: [...iv], bytes: [...new Uint8Array(bytes)] };
}
export async function openNativeKey(
  secret: string,
  value: SealedNativeKey,
  identity: string,
  previous?: string,
): Promise<string> {
  try {
    const bytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(value.iv), additionalData: encoder.encode(identity) },
      await key(secret, "decrypt"),
      new Uint8Array(value.bytes),
    );
    return new TextDecoder().decode(bytes);
  } catch (error) {
    if (previous !== undefined) return openNativeKey(previous, value, identity);
    throw error;
  }
}
