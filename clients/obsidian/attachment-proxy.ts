import type { AttachmentPort, DeviceMode } from "./attachments.ts";
export function attachmentProxy(input: {
  current: () => AttachmentPort | null;
  mode: DeviceMode;
  pins: { get(): readonly string[]; set(value: readonly string[]): Promise<void> };
}) {
  const listeners = new Set<() => void>(),
    notify = () => {
      for (const listener of listeners) listener();
    };
  const connected = () => {
    const value = input.current();
    if (!value) throw new Error("Connect this vault to Basalt first");
    return value;
  };
  const port: AttachmentPort = {
    mode: () => input.mode,
    summary: () =>
      input.current()?.summary() ?? { unsynced: [], cloudOnly: 0, downloading: 0, failed: [] },
    pins: () => (input.mode === "full" ? [] : input.pins.get()),
    entries: () => input.current()?.entries?.() ?? [],
    async setPinned(folder, pinned) {
      const current = input.current();
      if (current) await current.setPinned(folder, pinned);
      else {
        const values = new Set(input.pins.get());
        if (pinned) values.add(folder);
        else values.delete(folder);
        await input.pins.set([...values]);
      }
      notify();
    },
    async noteOpened(path, signal) {
      await input.current()?.noteOpened(path, signal);
    },
    async describeVersion(path, at) {
      return (await input.current()?.describeVersion?.(path, at)) ?? null;
    },
    async resolveMixed(ref, choices) {
      const resolve = connected().resolveMixed;
      if (!resolve) throw new Error("This device cannot resolve attachments yet");
      await resolve(ref, choices);
      notify();
    },
    async download(path, signal) {
      const download = connected().download;
      if (!download) throw new Error("Attachment downloads are unavailable");
      await download(path, signal);
      notify();
    },
    async evict(path) {
      const evict = connected().evict;
      if (!evict) throw new Error("Cache removal is unavailable");
      await evict(path);
      notify();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { port, notify, close: () => listeners.clear() };
}
