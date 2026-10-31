import { createHash } from "node:crypto";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { readPrivate, writePrivate } from "./private-files.ts";

/** File custody is an explicit headless choice, never a fallback from a failed OS store. */
export async function credentialStore(home: string, storage: "os" | "file") {
  if (storage === "file") {
    if (process.platform !== "linux")
      throw new Error(
        "File credential storage is available only for explicitly configured headless Linux.",
      );
    const file = join(home, "credentials.json");
    return {
      read: () => readPrivate(file),
      write: (value: string) => writePrivate(file, value),
      remove: () => rm(file, { force: true }),
    };
  }
  const account = createHash("sha256").update(home).digest("hex");
  try {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    const entry = new AsyncEntry("Signalbox Client", account, {
      linux: { store: "secret-service" },
    });
    return {
      read: async () => {
        try {
          return await entry.getPassword();
        } catch {
          throw new Error("The OS credential store is unavailable. Unlock it, then retry.");
        }
      },
      write: async (value: string) => {
        try {
          await entry.setPassword(value);
        } catch {
          throw new Error(
            "Could not save to the OS credential store. No plaintext copy was written.",
          );
        }
      },
      remove: async () => {
        try {
          await entry.deleteCredential();
        } catch {
          throw new Error("Could not remove the saved OS credential.");
        }
      },
    };
  } catch {
    throw new Error(
      "The OS credential store is unavailable. Headless Linux requires an explicit storage choice.",
    );
  }
}
