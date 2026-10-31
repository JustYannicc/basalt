import { Schema } from "effect";
import { useState } from "react";
import { Switch, View } from "react-native";
import { Button, Card, Field, Label, Notice, styles } from "./ui.tsx";

export const readPending = Schema.decodeUnknownSync(
  Schema.Struct({
    status: Schema.Literals(["approval-required", "input-required"]),
    requestId: Schema.NonEmptyString,
    expiresAt: Schema.Number,
    elicitation: Schema.Struct({
      message: Schema.String,
      requestedSchema: Schema.Struct({
        type: Schema.Literal("object"),
        properties: Schema.Record(Schema.String, Schema.Unknown),
        required: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
    }),
  }),
);
type Pending = ReturnType<typeof readPending>;
const readField = Schema.decodeUnknownSync(
  Schema.Struct({
    type: Schema.String,
    title: Schema.optionalKey(Schema.String),
    description: Schema.optionalKey(Schema.String),
    enum: Schema.optionalKey(Schema.Array(Schema.String)),
    enumNames: Schema.optionalKey(Schema.Array(Schema.String)),
    oneOf: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({ const: Schema.String, title: Schema.optionalKey(Schema.String) }),
      ),
    ),
    items: Schema.optionalKey(
      Schema.Struct({
        type: Schema.optionalKey(Schema.String),
        enum: Schema.optionalKey(Schema.Array(Schema.String)),
        anyOf: Schema.optionalKey(
          Schema.Array(Schema.Struct({ const: Schema.String, title: Schema.String })),
        ),
      }),
    ),
  }),
);
type Answer = string | number | boolean | string[];
export function ToolInteraction({
  pending,
  busy,
  answer,
}: {
  pending: Pending;
  busy: boolean;
  answer: (action: "accept" | "decline" | "cancel", content?: Record<string, Answer>) => void;
}) {
  const [values, setValues] = useState<Record<string, Answer>>({});
  const [error, setError] = useState("");
  let fields: [string, ReturnType<typeof readField>][] = [];
  let unsupported = false;
  try {
    fields = Object.entries(pending.elicitation.requestedSchema.properties).map(([name, field]) => [
      name,
      readField(field),
    ]);
    unsupported = fields.some(
      ([, field]) =>
        !["string", "number", "integer", "boolean"].includes(field.type) &&
        !(field.type === "array" && (field.items?.enum || field.items?.anyOf)),
    );
  } catch {
    unsupported = true;
  }
  const submit = () => {
    const required = pending.elicitation.requestedSchema.required ?? [];
    if (required.some((name) => values[name] === undefined || values[name] === "")) {
      setError("Fill in every required field.");
      return;
    }
    if (
      Object.values(values).some((value) => typeof value === "number" && !Number.isFinite(value))
    ) {
      setError("Enter a valid number.");
      return;
    }
    answer("accept", values);
  };
  return (
    <Card>
      <Label title>
        {pending.status === "approval-required" ? "Review this call" : "Your input is needed"}
      </Label>
      <Label selectable>{pending.elicitation.message}</Label>
      {fields.map(([name, field]) => {
        const label = `${field.title ?? name}${pending.elicitation.requestedSchema.required?.includes(name) ? " (required)" : ""}`;
        const update = (value: Answer) => setValues((old) => ({ ...old, [name]: value }));
        const choices =
          field.oneOf?.map((item) => ({ value: item.const, title: item.title ?? item.const })) ??
          field.enum?.map((value, index) => ({ value, title: field.enumNames?.[index] ?? value }));
        const multiple =
          field.items?.anyOf?.map((item) => ({ value: item.const, title: item.title })) ??
          field.items?.enum?.map((value) => ({ value, title: value }));
        return (
          <View key={name} style={styles.stack}>
            {field.description && (
              <Label small muted>
                {field.description}
              </Label>
            )}
            {field.type === "boolean" ? (
              <View style={styles.stack}>
                <Label>{label}</Label>
                <Switch
                  accessibilityLabel={label}
                  value={values[name] === true}
                  disabled={busy}
                  onValueChange={update}
                />
              </View>
            ) : choices ? (
              <>
                <Label>{label}</Label>
                {choices.map((choice) => (
                  <Button
                    key={choice.value}
                    label={`${values[name] === choice.value ? "✓ " : ""}${choice.title}`}
                    secondary
                    disabled={busy}
                    onPress={() => update(choice.value)}
                  />
                ))}
              </>
            ) : field.type === "array" && multiple ? (
              <>
                <Label>{label}</Label>
                {multiple.map(({ value, title }) => {
                  const current = values[name];
                  const selected = Array.isArray(current) ? current : [];
                  return (
                    <Button
                      key={value}
                      label={`${selected.includes(value) ? "✓ " : ""}${title}`}
                      secondary
                      disabled={busy}
                      onPress={() =>
                        update(
                          selected.includes(value)
                            ? selected.filter((item) => item !== value)
                            : [...selected, value],
                        )
                      }
                    />
                  );
                })}
              </>
            ) : ["string", "number", "integer"].includes(field.type) ? (
              <Field
                label={label}
                value={values[name] === undefined ? "" : String(values[name])}
                editable={!busy}
                keyboardType={field.type === "string" ? "default" : "numbers-and-punctuation"}
                onChangeText={(value) =>
                  update(field.type === "string" ? value : value === "" ? "" : Number(value))
                }
              />
            ) : null}
          </View>
        );
      })}
      {unsupported && (
        <Notice text="This form needs an input this app cannot show. Cancel it and use the web app." />
      )}
      {error && <Notice text={error} />}
      <Button
        label={pending.status === "approval-required" ? "Approve" : "Continue"}
        busy={busy}
        disabled={unsupported || pending.expiresAt <= Date.now()}
        onPress={submit}
      />
      <Button label="Decline" secondary disabled={busy} onPress={() => answer("decline")} />
      <Button label="Cancel call" secondary disabled={busy} onPress={() => answer("cancel")} />
    </Card>
  );
}
