import { useSyncExternalStore } from "react";
import { StyleSheet, View } from "react-native";
import type { AppUpdates, UpdateSnapshot } from "./update.ts";
import { Button, Card, Label, Notice, styles } from "./ui.tsx";

const local = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 16 },
  cell: { flexGrow: 1, flexBasis: 132 },
});
const none = () => () => {};
const missing = () => undefined;
const firstInstallHint = (brandName: string) =>
  `Android will ask you once to allow installs from ${brandName}.`;
type Props = { updates: AppUpdates; snapshot: UpdateSnapshot; brandName: string };

export function useUpdates(updates: AppUpdates | undefined) {
  return useSyncExternalStore(updates?.subscribe ?? none, updates?.getSnapshot ?? missing);
}

/** The home screen's quiet notice that a verified newer version is downloaded. */
export function UpdateBanner({ updates, snapshot, brandName }: Props) {
  const { state } = snapshot;
  if (state.kind !== "ready" || snapshot.dismissed) return null;
  return (
    <Card>
      <View style={styles.stack} accessibilityLiveRegion="polite">
        <Label>
          Update ready: {brandName} {state.version}
        </Label>
        {snapshot.firstInstall && (
          <Label small muted>
            {firstInstallHint(brandName)}
          </Label>
        )}
      </View>
      <View style={local.row}>
        <View style={local.cell}>
          <Button label="Install" onPress={() => void updates.install()} />
        </View>
        <View style={local.cell}>
          <Button label="Not now" secondary onPress={() => void updates.dismiss()} />
        </View>
      </View>
    </Card>
  );
}

function status(snapshot: UpdateSnapshot) {
  const { state } = snapshot;
  switch (state.kind) {
    case "idle":
      return undefined;
    case "checking":
      return "Checking for updates";
    case "current":
      return "Up to date";
    case "downloading":
      return `Downloading ${state.version}: ${Math.round(state.progress * 100)}%`;
    case "ready":
      return `Version ${state.version} is ready to install.`;
    case "failed":
      return undefined;
  }
}

/** The Updates section: installed version, what the updater is doing, and a manual check. */
export function UpdatesCard({ updates, snapshot, brandName }: Props) {
  const { state } = snapshot;
  const working = state.kind === "checking" || state.kind === "downloading";
  const text = status(snapshot);
  return (
    <Card>
      <View style={styles.stack} accessibilityLiveRegion="polite">
        <Label>Updates</Label>
        <Label small muted>
          Installed: {brandName} {snapshot.installed.version}
        </Label>
        {text && <Label small>{text}</Label>}
        {state.kind === "ready" && snapshot.dismissed && snapshot.firstInstall && (
          <Label small muted>
            {firstInstallHint(brandName)}
          </Label>
        )}
      </View>
      {state.kind === "failed" && <Notice text={state.message} />}
      {/* The banner already offers Install until it's dismissed. */}
      {state.kind === "ready" && snapshot.dismissed && (
        <Button label="Install" onPress={() => void updates.install()} />
      )}
      <Button
        label={state.kind === "failed" ? "Retry" : "Check for updates"}
        secondary
        busy={state.kind === "checking"}
        disabled={working}
        onPress={() => void updates.check()}
      />
    </Card>
  );
}
