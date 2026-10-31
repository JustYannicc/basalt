import { createContext, useContext } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from "react-native";
import type { TextInputProps } from "react-native";

const light = {
  background: "#f6f6f4",
  card: "#ffffff",
  text: "#20211f",
  muted: "#666960",
  line: "#dedfd9",
  accent: "#22251f",
  onAccent: "#ffffff",
  danger: "#a22323",
};
const dark = {
  background: "#141513",
  card: "#1e201c",
  text: "#f0f1ec",
  muted: "#a6aaa0",
  line: "#383b33",
  accent: "#e9eddf",
  onAccent: "#20231b",
  danger: "#ffaaa5",
};
const Theme = createContext(light);
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <Theme.Provider value={useColorScheme() === "dark" ? dark : light}>{children}</Theme.Provider>
  );
}
export const useTheme = () => useContext(Theme);
export function Label({
  children,
  muted = false,
  title = false,
  small = false,
  selectable = false,
}: {
  children: React.ReactNode;
  muted?: boolean;
  title?: boolean;
  small?: boolean;
  selectable?: boolean;
}) {
  const theme = useTheme();
  return (
    <Text
      selectable={selectable}
      style={{
        color: muted ? theme.muted : theme.text,
        fontSize: title ? 28 : small ? 14 : 17,
        fontWeight: title ? "600" : "400",
        lineHeight: title ? 35 : small ? 21 : 25,
      }}
    >
      {children}
    </Text>
  );
}
export function Button({
  label,
  onPress,
  disabled = false,
  secondary = false,
  danger = false,
  busy = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  danger?: boolean;
  busy?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: secondary ? theme.card : theme.accent,
          borderColor: theme.line,
          opacity: disabled || busy ? 0.45 : pressed ? 0.65 : 1,
        },
      ]}
    >
      {busy && <ActivityIndicator color={secondary ? theme.text : theme.onAccent} />}
      <Text
        style={{
          color: danger ? theme.danger : secondary ? theme.text : theme.onAccent,
          fontSize: 17,
          fontWeight: "600",
          flexShrink: 1,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const theme = useTheme();
  return (
    <View style={styles.stack}>
      <Label small muted>
        {label}
      </Label>
      <TextInput
        {...props}
        accessibilityLabel={label}
        placeholderTextColor={theme.muted}
        selectionColor={theme.text}
        style={[
          styles.input,
          { color: theme.text, borderColor: theme.line, backgroundColor: theme.card },
          props.multiline ? { minHeight: 108, textAlignVertical: "top" } : undefined,
        ]}
      />
    </View>
  );
}
export function Card({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={[styles.card, { borderColor: theme.line, backgroundColor: theme.card }]}>
      {children}
    </View>
  );
}
export function Notice({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <Text
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{ color: theme.danger, fontSize: 16, lineHeight: 24 }}
    >
      {text}
    </Text>
  );
}
export const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { padding: 24, gap: 24, width: "100%", maxWidth: 660, alignSelf: "center" },
  stack: { gap: 8 },
  group: { gap: 16 },
  card: { borderRadius: 16, borderWidth: 1, padding: 20, gap: 16 },
  button: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 13,
    minHeight: 50,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 10,
  },
  input: { borderWidth: 1, borderRadius: 10, padding: 14, minHeight: 50, fontSize: 17 },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
});
