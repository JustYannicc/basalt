/**
 * Local file events cannot wake an idle vault when another device or an agent edits the cloud.
 * This is a fetch, like `git fetch` on a timer: it never commits, so a slow interval is enough.
 */
export const remoteWakeMs = 5 * 60_000;

export function watchRemoteChanges(input: {
  repeat: (callback: () => void, milliseconds: number) => () => void;
  available: () => boolean;
  pull: () => void;
}) {
  return input.repeat(() => {
    if (input.available()) input.pull();
  }, remoteWakeMs);
}
