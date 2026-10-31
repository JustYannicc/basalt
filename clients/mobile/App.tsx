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
  const [server, setServer] = useState(defaultOrigin);
  const [customServer, setCustomServer] = useState(!defaultOrigin);
  const [screen, setScreen] = useState<"home" | "model" | "tools">("home");
  const connection = snapshot.connection;
  const busy = Boolean(snapshot.busy);
  const connected = connection?.state === "connected" && connection.health?.state !== "offline";
  useEffect(() => {
    void controller.initialize();
    const subscription = AppState.addEventListener("change", (state) => {
      void controller.foreground(state === "active");
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
  useEffect(() => {
    if (connection?.origin) setServer(connection.origin);
  }, [connection?.origin]);
  const ready = snapshot.phase === "ready" || connection !== undefined;
  const state = busy
    ? snapshot.busy
    : snapshot.phase === "starting"
      ? "Opening your connection"
      : connection?.state === "sign-in-required"
        ? "Sign in again"
        : connection?.state === "revoked"
          ? "Device revoked"
          : connection?.state === "disconnected"
            ? "Disconnected"
            : connected
              ? "Connected"
              : connection?.health?.state === "offline"
                ? "Offline"
                : "Not connected";
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
              <Card>
                <Label>{state}</Label>
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
                {ready && (
                  <Button
                    label={connected ? "Disconnect" : "Reconnect"}
                    secondary
                    disabled={busy}
                    onPress={() => {
                      void (connected ? controller.disconnect() : controller.reconnect());
                    }}
                  />
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
              {snapshot.error && <Notice text={snapshot.error} />}
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
              {(!connected || snapshot.code) && snapshot.phase !== "starting" && (
                <View style={styles.group}>
                  {!snapshot.code && (
                    <>
                      {customServer && (
                        <Field
                          label="Server"
                          value={server}
                          onChangeText={setServer}
                          keyboardType="url"
                          autoCapitalize="none"
                          autoCorrect={false}
                          editable={!busy}
                        />
                      )}
                      <Button
                        label={`Sign in to ${brandName}`}
                        busy={snapshot.busy === "Sign in"}
                        disabled={busy}
                        onPress={() => {
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
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
