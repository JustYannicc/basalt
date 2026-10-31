import { credentialStore } from "./credential-store.ts";
import { control } from "./ipc.ts";
import {
  ipcPath,
  loadProfile,
  operatorToken,
  withProfile,
  withStoppedConnection,
} from "./profile.ts";

export async function signOut(home: string) {
  try {
    await control(ipcPath(home), await operatorToken(home), "sign-out");
  } catch {
    // The lease prevents deleting credentials while a running process can still use them.
    await withStoppedConnection(home, () =>
      withProfile(home, async () => {
        const profile = await loadProfile(home);
        const store = await credentialStore(home, profile.storage);
        if ((await store.read()) !== undefined) await store.remove();
      }),
    );
  }
}
