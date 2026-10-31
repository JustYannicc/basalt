import { Schema } from "effect";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { MobileController } from "./controller.ts";
import { connectTools, ToolCallError } from "../connection/tools.ts";
import { readPending, ToolInteraction } from "./ToolInteraction.tsx";
import { Button, Card, Field, Label, Notice, styles } from "./ui.tsx";

const readSearch = Schema.decodeUnknownSync(
  Schema.Struct({
    items: Schema.Array(
      Schema.Struct({ path: Schema.String, description: Schema.String, input: Schema.String }),
    ),
    remaining: Schema.Number,
    next: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const readDescription = Schema.decodeUnknownSync(
  Schema.Struct({
    items: Schema.Array(
      Schema.Struct({ path: Schema.String, description: Schema.String, signature: Schema.String }),
    ),
  }),
);
const displayResult = (value: unknown) => {
  const text = JSON.stringify(value, null, 2);
  return text.length > 128_000
    ? "The server returned a result that is too large to display here. Check the tool's app before starting it again."
    : text;
};
export function ToolsScreen({ controller }: { controller: MobileController }) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<ReturnType<typeof readSearch>>();
  const [selected, setSelected] = useState<ReturnType<typeof readSearch>["items"][number]>();
  const [description, setDescription] = useState("");
  const [input, setInput] = useState("{}");
  const [editingInput, setEditingInput] = useState(false);
  const [result, setResult] = useState("");
  const [pending, setPending] = useState<ReturnType<typeof readPending>>();
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
  const call = async (
    name: string,
    args: Record<string, unknown>,
    receive: (value: unknown) => void,
  ) => {
    if (active.current) return;
    const operation = new AbortController();
    active.current = operation;
    setBusy(true);
    setError("");
    try {
      const value = await controller.run(async (source, signal) => {
        const client = await connectTools(source, signal);
        try {
          return await client.call(name, args);
        } finally {
          await client.close();
        }
      }, operation.signal);
      if (mounted.current) receive(value);
    } catch (error) {
      if (mounted.current) {
        if (error instanceof ToolCallError) {
          setResult(displayResult(error.result));
          setEditingInput(true);
          setError(error.message);
        } else
          setError(
            "The request stopped. Its outcome may be unknown. It was not replayed. Check the tool's app before starting it again.",
          );
      }
    } finally {
      active.current = undefined;
      if (mounted.current) setBusy(false);
    }
  };
  const execution = (value: unknown) => {
    setResult(displayResult(value));
    try {
      setPending(readPending(value));
    } catch {
      const outcome = Schema.decodeUnknownSync(Schema.Struct({ status: Schema.String }))(value);
      if (outcome.status === "completed" || outcome.status === "unavailable") setPending(undefined);
      else
        setError("This call has not finished. Keep its existing request; do not start it again.");
    }
  };
  const find = (args: Record<string, unknown>) =>
    call("search", args, (value) => {
      setSearch(readSearch(value));
      setSelected(undefined);
      setDescription("");
      setResult("");
    });
  return (
    <View style={styles.group}>
      <Label title>Find a tool</Label>
      {!selected && (
        <>
          <Label muted>Search the apps connected to your account.</Label>
          <Field
            label="Search tools"
            value={query}
            onChangeText={setQuery}
            placeholder="For example, list calendars"
            editable={!busy && !pending}
            returnKeyType="search"
            onSubmitEditing={() => {
              if (!pending) void find({ query, limit: 10 });
            }}
          />
          <Button
            label="Search"
            busy={busy}
            disabled={Boolean(pending)}
            onPress={() => {
              void find({ query, limit: 10 });
            }}
          />
        </>
      )}
      {!selected && search?.items.length === 0 && (
        <Label muted>No tools matched this search.</Label>
      )}
      {!selected &&
        search?.items.map((item) => (
          <Card key={item.path}>
            <Label>{item.path.replace(/^tools\./u, "")}</Label>
            <Label small muted>
              {item.description}
            </Label>
            <Button
              label="Use this tool"
              secondary
              disabled={busy || Boolean(pending)}
              onPress={() => {
                setSelected(item);
                setInput("{}");
                setEditingInput(false);
                setResult("");
                void call("describe", { paths: [item.path] }, (value) =>
                  setDescription(readDescription(value).items[0]?.signature ?? item.input),
                );
              }}
            />
          </Card>
        ))}
      {!selected && search?.next && (
        <Button
          label={`More tools (${search.remaining})`}
          secondary
          disabled={busy || Boolean(pending)}
          onPress={() => {
            if (search.next) void find(search.next);
          }}
        />
      )}
      {selected && (
        <Button
          label="All tools"
          secondary
          disabled={busy || Boolean(pending)}
          onPress={() => {
            setSelected(undefined);
            setError("");
            setResult("");
          }}
        />
      )}
      {selected && (
        <Card>
          <Label>{selected.path}</Label>
          <Label muted>{selected.description}</Label>
          <Button
            label={editingInput ? "Hide input" : "Edit tool input"}
            secondary
            disabled={busy || Boolean(pending)}
            onPress={() => setEditingInput(!editingInput)}
          />
          {editingInput && (
            <>
              <Label small selectable>
                {description || selected.input}
              </Label>
              <Field
                label="Tool input (JSON)"
                value={input}
                onChangeText={setInput}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={64_000}
                editable={!busy && !pending}
              />
            </>
          )}
          <Button
            label="Run tool"
            disabled={busy || Boolean(pending)}
            onPress={() => {
              try {
                const value: unknown = JSON.parse(input);
                if (!value || typeof value !== "object" || Array.isArray(value))
                  throw new Error("Invalid input.");
                void call("call", { calls: { path: selected.path, input: value } }, execution);
              } catch {
                setError("Tool input must be a JSON object.");
              }
            }}
          />
        </Card>
      )}
      {pending && (
        <ToolInteraction
          key={pending.requestId}
          pending={pending}
          busy={busy}
          answer={(action, content) => {
            void call(
              "resume",
              {
                requestId: pending.requestId,
                response: { action, ...(action === "accept" ? { content: content ?? {} } : {}) },
              },
              execution,
            );
          }}
        />
      )}
      {busy && <Button label="Stop waiting" secondary onPress={() => active.current?.abort()} />}
      {error && <Notice text={error} />}
      {result && (!pending || error) && (
        <Card>
          <Label small selectable>
            {result}
          </Label>
        </Card>
      )}
    </View>
  );
}
