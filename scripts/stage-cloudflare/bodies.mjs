// What a stage may send as the body of a change, checked by the choke point (request.mjs) before
// anything is sent. Each operation has an exact schema, closed at every level: an unknown field is
// refused wherever it appears, so no body can carry a secret, a key, a binding or another
// resource's id. The fields are those the scale test's resize sends (scripts/scale-test/run.mjs): a
// patch of `max_instances` and `configuration`, then a rollout of that configuration. A
// configuration may change only `instance_type`; every other field it carries must equal the
// application's own configuration, both as the stage's listing recorded it (checked before anything
// is sent) and as its id answers in the read-back just before the change, so its image, environment
// and network stay its own even against a listing that lies. What is sent is the checked copy, never the caller's object.
import { fail } from "./answers.mjs";

const refuse = (message) => fail(`Refused: ${message}`);
const node = (fields) => Object.freeze(Object.assign(Object.create(null), fields));
const string = node({ type: "string" });
const number = node({ type: "number" });
const boolean = node({ type: "boolean" });
const integer = (min, max) => node({ type: "integer", min, max });
const oneOf = (...values) => node({ type: "oneOf", values: Object.freeze(values) });
const list = (item) => node({ type: "list", item });
const fields = (named) => node({ type: "fields", fields: node(named) });

/** Cloudflare's container instance types. */
const INSTANCE_TYPES = ["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"];
/** A container application's configuration as its read-back records it, and its instance type. */
const CONFIGURATION = fields({
  image: string,
  instance_type: oneOf(...INSTANCE_TYPES),
  vcpu: number,
  memory: string,
  memory_mib: integer(0, Number.MAX_SAFE_INTEGER),
  disk: fields({ size_mb: integer(0, Number.MAX_SAFE_INTEGER), size: string }),
  environment_variables: list(fields({ name: string, value: string })),
  network: fields({ assign_ipv4: string, assign_ipv6: string, mode: string }),
  command: list(string),
  entrypoint: list(string),
  runtime: string,
  observability: fields({ logs: fields({ enabled: boolean }) }),
});
/** The one field of a configuration a stage may change. */
const CHANGEABLE = "instance_type";
const BODIES = node({
  patch: fields({ max_instances: integer(0, 100), configuration: CONFIGURATION }),
  rollout: fields({
    description: string,
    strategy: oneOf("rolling"),
    kind: oneOf("full_auto"),
    step_percentage: integer(1, 100),
    target_configuration: CONFIGURATION,
  }),
});
const MAX_ITEMS = 100;
const MAX_TEXT = 4096;

/** `value` checked against `schema` and copied, each field read once; a refusal names `path`. */
function checked(schema, value, path, what) {
  const subject = path ? `${what}'s ${path}` : what;
  switch (schema.type) {
    case "string":
      if (typeof value !== "string" || value.length > MAX_TEXT)
        throw refuse(`${subject} is not text a stage may send`);
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value))
        throw refuse(`${subject} is not a number`);
      return value;
    case "integer":
      if (!Number.isSafeInteger(value) || value < schema.min || value > schema.max)
        throw refuse(`${subject} is not a whole number from ${schema.min} to ${schema.max}`);
      return value;
    case "boolean":
      if (typeof value !== "boolean") throw refuse(`${subject} is not true or false`);
      return value;
    case "oneOf":
      if (typeof value !== "string" || !schema.values.includes(value))
        throw refuse(`${subject} is not one of ${schema.values.join(", ")}`);
      return value;
    case "list": {
      if (!Array.isArray(value)) throw refuse(`${subject} is not a list`);
      const length = value.length;
      if (!Number.isSafeInteger(length) || length > MAX_ITEMS)
        throw refuse(`${subject} has more than ${MAX_ITEMS} items`);
      const copy = [];
      for (let index = 0; index < length; index++)
        copy.push(checked(schema.item, value[index], `${path}[${index}]`, what));
      return Object.freeze(copy);
    }
    case "fields": {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw refuse(`${subject} is not an object of named fields`);
      const copy = Object.create(null);
      for (const key of Reflect.ownKeys(value)) {
        const name = typeof key === "string" ? key : String(key);
        const child = typeof key === "string" ? schema.fields[key] : undefined;
        if (child === undefined)
          throw refuse(`${what} takes no ${path ? `${path}.` : ""}${name} field`);
        copy[key] = checked(child, value[key], path ? `${path}.${key}` : key, what);
      }
      return Object.freeze(copy);
    }
    default:
      throw refuse(`${subject} has no schema`);
  }
}

/** Whether two checked values of `schema` are the same, field by field. */
function same(schema, a, b) {
  if (schema.type === "list")
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => same(schema.item, item, b[index]))
    );
  if (schema.type !== "fields") return a === b;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && same(schema.fields[key], a[key], b[key]))
  );
}

/**
 * A frozen copy of a listed application's configuration, read once when it is listed, or undefined
 * when it holds anything the configuration schema does not: such an application can still be read
 * and deleted, but no configuration can be sent for it.
 */
export function recordedConfiguration(value) {
  try {
    return checked(CONFIGURATION, value, "", "a listed configuration");
  } catch {
    return undefined;
  }
}

/**
 * The body a `operation` may send for an application whose listing recorded `configuration`: a
 * checked copy, or a refusal, naming the field, before anything is sent.
 */
export function checkedBody(operation, body, configuration) {
  const schema = typeof operation === "string" ? BODIES[operation] : undefined;
  const what = `a ${operation} body`;
  if (schema === undefined) throw refuse(`${String(operation)} takes no body`);
  const copy = checked(schema, body, "", what);
  for (const field of ["configuration", "target_configuration"]) {
    if (!Object.hasOwn(copy, field)) continue;
    for (const key of Object.keys(copy[field]))
      if (
        key !== CHANGEABLE &&
        (configuration === undefined ||
          !Object.hasOwn(configuration, key) ||
          !same(CONFIGURATION.fields[key], copy[field][key], configuration[key]))
      )
        throw refuse(`${what}'s ${field}.${key} is not the application's own`);
  }
  return copy;
}
