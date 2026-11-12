import { useSyncExternalStore } from "react";
import { View } from "react-native";
import type { AppUpdates, UpdateSnapshot } from "./update.ts";
import { Button, Card, Label, Notice, styles } from "./ui.tsx";

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
      <View style={styles.row}>
        <View style={styles.cell}>
          <Button
            label="Install"
            busy={snapshot.installing}
            onPress={() => void updates.install()}
          />
        </View>
        <View style={styles.cell}>
          <Button label="Not now" secondary onPress={() => void updates.dismiss()} />
        </View>
      </View>
      {snapshot.error && <Notice text={snapshot.error} />}
    </Card>
  );
}

/** One line per state; screen readers announce it when the state changes, never per percent. */
function status(snapshot: UpdateSnapshot) {
  const { state } = snapshot;
  switch (state.kind) {
    case "downloading":
      return `Downloading ${state.version}`;
    case "ready":
      return `Version ${state.version} is ready to install.`;
    case "current":
      return snapshot.checking ? "Checking for updates" : "Up to date";
    case "idle":
      return snapshot.checking ? "Checking for updates" : undefined;
  }
}

/** The Updates section: installed version, what the updater is doing, and a manual check. */
export function UpdatesCard({ updates, snapshot, brandName }: Props) {
  const { state } = snapshot;
  const text = status(snapshot);
  return (
    <Card>
      <View style={styles.stack}>
        <Label>Updates</Label>
        <Label small muted>
          Installed: {brandName} {snapshot.installed.version}
        </Label>
        <View accessibilityLiveRegion="polite">{text && <Label small>{text}</Label>}</View>
        {state.kind === "downloading" && (
          <Label small muted>
            {state.progress}%
          </Label>
        )}
        {state.kind === "ready" && snapshot.dismissed && snapshot.firstInstall && (
          <Label small muted>
            {firstInstallHint(brandName)}
          </Label>
        )}
      </View>
      {/* The banner shows its own failure and Install until it's dismissed. */}
      {snapshot.error && (state.kind !== "ready" || snapshot.dismissed) && (
        <Notice text={snapshot.error} />
      )}
      {state.kind === "ready" && snapshot.dismissed && (
        <Button label="Install" busy={snapshot.installing} onPress={() => void updates.install()} />
      )}
      <Button
        label={snapshot.error ? "Retry" : "Check for updates"}
        secondary
        busy={snapshot.checking}
        disabled={state.kind === "downloading"}
        onPress={() => void updates.check()}
      />
    </Card>
  );
}
