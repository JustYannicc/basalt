import { useEffect, useState, useSyncExternalStore } from "react";
import {
  Alert,
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  View,
} from "react-native";
import Constants from "expo-constants";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { controller } from "./native.ts";
import { Button, Card, Field, Label, Notice, ThemeProvider, styles, useTheme } from "./ui.tsx";
import { ModelScreen } from "./ModelScreen.tsx";
import { ToolsScreen } from "./ToolsScreen.tsx";
import { updates } from "./update-native.ts";
import { UpdateBanner, UpdatesCard, useUpdates } from "./UpdateViews.tsx";

const defaults = Constants.expoConfig?.extra;
const brandName = typeof defaults?.brandName === "string" ? defaults.brandName : "Signalbox";
const defaultOrigin = typeof defaults?.serverOrigin === "string" ? defaults.serverOrigin : "";
export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <Home />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
function Home() {
  const theme = useTheme();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const update = useUpdates(updates);
  const [draft, setDraft] = useState<{ value: string; origin: string | undefined }>();
  const [customServer, setCustomServer] = useState(!defaultOrigin);
  const [screen, setScreen] = useState<"home" | "model" | "tools">("home");
  const connection = snapshot.connection;
  const origin = connection?.origin;
  // An edit belongs to the saved origin it was typed against; a different saved origin replaces it.
  // Sign-in, sign-out and revoke clear the saved origin, so their handlers seed the draft first.
  const server =
    draft && (origin === undefined || draft.origin === origin)
      ? draft.value
      : (origin ?? defaultOrigin);
  const keepServer = (value = server) => setDraft({ value, origin });
  const busy = Boolean(snapshot.busy);
  const reconnecting = Boolean(snapshot.reconnecting);
  // Credentials the server refused: only a fresh sign-in helps, so Reconnect is hidden.
  const terminal = connection?.state === "sign-in-required" || connection?.state === "revoked";
  // Capabilities stay empty until the server has validated this device again.
  const connected =
    connection?.state === "connected" &&
    !reconnecting &&
    connection.health?.state !== "offline" &&
    connection.capabilities.length > 0;
  useEffect(() => {
    void controller.initialize();
    void updates?.launch();
    const subscription = AppState.addEventListener("change", (state) => {
      void controller.foreground(state === "active");
      if (state === "active") void updates?.foreground();
    });
    const timer = setInterval(() => {
      void controller.checkHealth();
    }, 15_000);
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (screen === "home") return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      setScreen("home");
      return true;
    });
    return () => back.remove();
  }, [screen]);
  const ready = snapshot.phase === "ready" || connection !== undefined;
  const state = busy
    ? snapshot.busy
    : snapshot.phase === "starting"
      ? "Opening your connection"
      : connection?.state === "sign-in-required"
        ? "Sign in again"
        : connection?.state === "revoked"
          ? "Device revoked"
          : reconnecting
            ? "Reconnecting"
            : connection?.state === "disconnected"
              ? "Disconnected"
              : connected
                ? "Connected"
                : connection?.health?.state === "offline"
                  ? "Offline"
                  : connection?.state === "connected"
                    ? "Checking connection"
                    : "Not connected";
  // The automatic-retry message belongs with the status, not with failures below.
  const statusDetail = reconnecting ? snapshot.error : undefined;
  // A live credential that is only recovering needs no new sign-in.
  const showSignIn =
    (connection?.state !== "connected" || Boolean(snapshot.code)) && snapshot.phase !== "starting";
  return (
    <SafeAreaView style={[styles.page, { backgroundColor: theme.background }]}>
      <StatusBar barStyle={theme.background === "#141513" ? "light-content" : "dark-content"} />
      {screen !== "home" && (
        <View style={[styles.header, { borderColor: theme.line }]}>
          <Button label="Back" secondary onPress={() => setScreen("home")} />
          <Label>{brandName}</Label>
        </View>
      )}
      <KeyboardAvoidingView
        style={styles.page}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {screen === "model" ? (
            <ModelScreen controller={controller} />
          ) : screen === "tools" ? (
            <ToolsScreen controller={controller} />
          ) : (
            <>
              <View style={styles.stack}>
                <Label title>{brandName}</Label>
                <Label muted>Your models and tools, wherever you are.</Label>
              </View>
              {updates && update && (
                <UpdateBanner updates={updates} snapshot={update} brandName={brandName} />
              )}
              <Card>
                <View style={styles.stack} accessibilityLiveRegion="polite">
                  <Label>{state}</Label>
                  {statusDetail && (
                    <Label small muted>
                      {statusDetail}
                    </Label>
                  )}
                </View>
                {connection?.display && (
                  <View style={styles.stack}>
                    <Label>
                      {connection.display.account.name || connection.display.account.email}
                    </Label>
                    <Label small muted>
                      {connection.display.account.email}
                    </Label>
                    <Label small muted>
                      Pool: {connection.display.pool.name || connection.display.pool.id}
                    </Label>
                  </View>
                )}
                {connection?.origin && (
                  <Label small muted>
                    {connection.origin}
                  </Label>
                )}
                {connection?.state === "connected" && origin && (
                  <Button
                    label="Choose pool in browser"
                    secondary
                    disabled={busy}
                    onPress={() => {
                      keepServer(origin);
                      void controller.signIn(origin);
                    }}
                  />
                )}
                {connected && (
                  <>
                    <Button
                      label="Try a model"
                      disabled={busy || !connection?.capabilities.includes("models")}
                      onPress={() => setScreen("model")}
                    />
                    <Button
                      label="Find a tool"
                      secondary
                      disabled={busy || !connection?.capabilities.includes("tools")}
                      onPress={() => setScreen("tools")}
                    />
                  </>
                )}
                {ready && !terminal && (
                  <View style={styles.row}>
                    <View style={styles.cell}>
                      <Button
                        label="Reconnect"
                        secondary
                        busy={snapshot.busy === "Reconnect"}
                        disabled={busy}
                        onPress={() => {
                          void controller.reconnect();
                        }}
                      />
                    </View>
                    <View style={styles.cell}>
                      <Button
                        label="Disconnect"
                        secondary
                        disabled={busy || connection?.state !== "connected"}
                        onPress={() => {
                          void controller.disconnect();
                        }}
                      />
                    </View>
                  </View>
                )}
              </Card>
              {snapshot.code && (
                <Card>
                  <Label>Approve this phone in your browser</Label>
                  <Label title selectable>
                    {snapshot.code}
                  </Label>
                  <Label muted>Check that the browser shows this code.</Label>
                </Card>
              )}
              {snapshot.error && !statusDetail && <Notice text={snapshot.error} />}
              {snapshot.phase === "storage-error" && (
                <Button
                  label="Reconnect"
                  secondary
                  disabled={busy}
                  onPress={() => {
                    void controller.reconnect();
                  }}
                />
              )}
              {showSignIn && (
                <View style={styles.group}>
                  {!snapshot.code && (
                    <>
                      {customServer && (
                        <Field
                          label="Server"
                          value={server}
                          onChangeText={(value) => setDraft({ value, origin })}
                          keyboardType="url"
                          autoCapitalize="none"
                          autoCorrect={false}
                          editable={!busy}
                        />
                      )}
                      <Button
                        label={terminal ? "Sign in again" : `Sign in to ${brandName}`}
                        busy={snapshot.busy === "Sign in"}
                        disabled={busy}
                        onPress={() => {
                          keepServer();
                          void controller.signIn(server.trim().replace(/\/$/u, ""));
                        }}
                      />
                      <Button
                        label={customServer ? "Hide server" : "Use another server"}
                        secondary
                        disabled={busy}
                        onPress={() => setCustomServer(!customServer)}
                      />
                    </>
                  )}
                  {snapshot.busy === "Sign in" && (
                    <Button label="Cancel sign-in" secondary onPress={controller.cancel} />
                  )}
                </View>
              )}
              {(ready || snapshot.phase === "storage-error") && (
                <View style={styles.group}>
                  <Button
                    label="Sign out"
                    secondary
                    disabled={busy}
                    onPress={() => {
                      keepServer();
                      void controller.signOut();
                    }}
                  />
                  {ready && (
                    <Button
                      label="Revoke this phone"
                      secondary
                      danger
                      disabled={busy}
                      onPress={() =>
                        Alert.alert(
                          "Revoke this phone?",
                          "This removes its server access. You will need to sign in again.",
                          [
                            { text: "Cancel", style: "cancel" },
                            {
                              text: "Revoke",
                              style: "destructive",
                              onPress: () => {
                                keepServer();
                                void controller.revoke();
                              },
                            },
                          ],
                        )
                      }
                    />
                  )}
                </View>
              )}
              {/* The app has no settings screen; updates sit last on home, like the account actions. */}
              {updates && update && (
                <UpdatesCard updates={updates} snapshot={update} brandName={brandName} />
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
