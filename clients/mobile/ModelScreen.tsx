import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { MobileController } from "./controller.ts";
import { availableModels, tryModel } from "../connection/models.ts";
import { Button, Card, Field, Label, Notice, styles } from "./ui.tsx";

export function ModelScreen({ controller }: { controller: MobileController }) {
  const [models, setModels] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [filter, setFilter] = useState("");
  const [prompt, setPrompt] = useState("");
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);
  const run = async (action: (signal: AbortSignal) => Promise<unknown>) => {
    if (active.current) return;
    const operation = new AbortController();
    active.current = operation;
    setBusy(true);
    setError("");
    try {
      await action(operation.signal);
    } catch {
      if (mounted.current)
        setError("The request stopped. It was not replayed. Any partial reply is kept below.");
    } finally {
      active.current = undefined;
      if (mounted.current) setBusy(false);
    }
  };
  const load = () =>
    run(async (signal) => {
      const result = await controller.run(availableModels, signal);
      if (mounted.current) {
        setModels(result);
        setSelected((value) => (result.includes(value) ? value : ""));
      }
    });
  useEffect(() => {
    void load();
  }, []);
  const matches = models.filter((model) => model.toLowerCase().includes(filter.toLowerCase()));
  return (
    <View style={styles.group}>
      <Label title>Try a model</Label>
      <Label muted>Use the models available in your pool.</Label>
      <Field
        label="Find a model"
        value={filter}
        onChangeText={setFilter}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
      />
      {selected && <Label>Selected: {selected}</Label>}
      <View style={styles.stack}>
        {matches.slice(0, 20).map((model) => (
          <Button
            key={model}
            label={`${selected === model ? "✓ " : ""}${model}`}
            secondary
            onPress={() => setSelected(model)}
            disabled={busy}
          />
        ))}
        {matches.length > 20 && (
          <Label small muted>
            Type more to narrow {matches.length} models.
          </Label>
        )}
        {!busy && models.length === 0 && <Label muted>No models were returned.</Label>}
      </View>
      <Button
        label="Refresh models"
        secondary
        onPress={() => {
          void load();
        }}
        disabled={busy}
      />
      <Field
        label="Message"
        value={prompt}
        onChangeText={setPrompt}
        placeholder="What would you like to try?"
        multiline
        maxLength={16_000}
        editable={!busy}
      />
      <Button
        label="Send"
        busy={busy}
        disabled={!selected || !prompt.trim()}
        onPress={() => {
          setReply("");
          void run((signal) =>
            controller.run(
              (source, activeSignal) =>
                tryModel(source, selected, prompt, activeSignal, (text) => {
                  if (mounted.current) setReply(text);
                }),
              signal,
            ),
          );
        }}
      />
      {busy && <Button label="Stop" secondary onPress={() => active.current?.abort()} />}
      {error && <Notice text={error} />}
      {reply && (
        <Card>
          <Label selectable>{reply}</Label>
        </Card>
      )}
    </View>
  );
}
