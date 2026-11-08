/** Local file events cannot wake an idle vault when another device or an agent edits the cloud. */
export function watchRemoteChanges(input: {
  repeat: (callback: () => void, milliseconds: number) => () => void;
  available: () => boolean;
  sync: () => void;
}) {
  return input.repeat(() => {
    if (input.available()) input.sync();
  }, 30_000);
}
