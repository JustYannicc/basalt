import assert from "node:assert/strict";
import { test } from "node:test";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import {
  annotationWireName,
  callerOwnedAnnotations,
  providerManagedAnnotations,
} from "./worker-annotations.ts";

// Every field Cloudflare's script-settings read returns must, for each class write built from it,
// be accepted by that write's schema (recursively) or be named here as not echoed. A new
// provider-managed field then fails this test instead of the next production release.

interface Node {
  _tag: string;
  thunk?: () => Node;
  types?: readonly Node[];
  propertySignatures?: readonly { name: PropertyKey; type: Node }[];
  rest?: readonly Node[];
}
const resolve = (node: Node): Node => {
  if (node._tag === "Suspend") return resolve(node.thunk!());
  if (node._tag !== "Union") return node;
  const members = node.types!.map(resolve).filter((n) => !["Null", "Undefined"].includes(n._tag));
  return members.length === 1 ? members[0]! : node;
};
const fields = (node: Node) => {
  const resolved = resolve(node);
  return resolved._tag === "Objects"
    ? new Map(resolved.propertySignatures!.map((p) => [String(p.name), p.type]))
    : undefined;
};
const element = (node: Node) => {
  const resolved = resolve(node);
  return resolved._tag === "Arrays" ? resolved.rest?.[0] : undefined;
};
const ast = (schema: unknown) => (schema as { ast: Node }).ast;

/** Read fields a class write does not echo, and why. Anything else must be accepted as read. */
const notEchoed = {
  "expansion PUT": {
    schema: Workers.PutScriptMetadata,
    fields: {
      bindings: "derived: inherit by name, plus the declared class bindings",
      cacheOptions: "refused: declared-class-baseline-settings-unsupported",
      exports: "refused: declared-class-baseline-settings-unsupported",
      exportsReconciliation: "dropped: Cloudflare's summary of an exports upload",
      migrations: "derived: built from the active version's runtime tag",
      tags: "derived: alchemy's declared tags",
      usageModel: "refused unless standard, Cloudflare's default, which is not echoed",
    },
  },
  "clone POST": {
    schema: Workers.CreateBetaWorkerVersionRequest,
    fields: {
      bindings: "derived: inherit from the exact active version",
      cacheOptions: "refused by the expansion PUT, built first",
      exports: "refused by the expansion PUT, built first",
      exportsReconciliation: "dropped: Cloudflare's summary of an exports upload",
      logpush: "dropped: script-level, not part of a version",
      migrations: "dropped: a staged clone carries none; assertClone refuses one",
      observability: "dropped: script-level, not part of a version",
      tags: "dropped: script-level, not part of a version",
      tailConsumers: "dropped: script-level, not part of a version",
    },
  },
} as const;

function unaccepted(read: Node, write: Node, path: string, skip: Record<string, string>) {
  const issues: string[] = [];
  const writable = fields(write);
  for (const [key, type] of fields(read) ?? []) {
    const at = path ? `${path}.${key}` : key;
    if (!path && key in skip) continue;
    const accepted = writable?.get(key);
    if (!path && key === "annotations") {
      const sent = accepted && fields(accepted);
      for (const name of fields(type)?.keys() ?? []) {
        const wire = annotationWireName(name);
        if (providerManagedAnnotations.has(wire)) continue;
        if (!callerOwnedAnnotations.has(wire)) issues.push(`${at}.${name}: unknown annotation`);
        else if (!sent?.has(name)) issues.push(`${at}.${name}: caller-owned but not writable`);
      }
      continue;
    }
    if (!accepted) {
      issues.push(`${at}: echoed but the write has no such field`);
      continue;
    }
    const readItem = element(type);
    const writeItem = element(accepted);
    if (fields(type)) {
      if (fields(accepted)) issues.push(...unaccepted(type, accepted, at, skip));
      else if (resolve(accepted)._tag !== "Unknown") issues.push(`${at}: object read, not written`);
    } else if (readItem && fields(readItem)) {
      if (writeItem && fields(writeItem))
        issues.push(...unaccepted(readItem, writeItem, `${at}[]`, skip));
      else issues.push(`${at}: list of objects read, not written`);
    }
  }
  return issues;
}

for (const [write, plan] of Object.entries(notEchoed))
  test(`every script-settings field is accepted by the ${write} or named as not echoed`, () => {
    const read = ast(Workers.GetScriptScriptAndVersionSettingResponse);
    const known = [...(fields(read)?.keys() ?? [])];
    assert.deepEqual(
      Object.keys(plan.fields).filter((key) => !known.includes(key)),
      [],
      "a not-echoed entry names a field the read no longer has",
    );
    assert.deepEqual(unaccepted(read, ast(plan.schema), "", plan.fields), []);
  });

test("the walk catches a provider-managed annotation the write refuses", () => {
  // The vendored PUT schema has no workers/triggered_by: an echo of the whole annotation object fails.
  const put = fields(ast(Workers.PutScriptMetadata))!.get("annotations")!;
  const read = fields(ast(Workers.GetScriptScriptAndVersionSettingResponse))!.get("annotations")!;
  assert.equal(fields(read)?.has("workersTriggeredBy"), true);
  assert.equal(fields(put)?.has("workersTriggeredBy"), false);
});

test("the walk is not vacuous: with nothing named, it reports exactly the fields the writes cannot take", () => {
  const read = ast(Workers.GetScriptScriptAndVersionSettingResponse);
  assert.deepEqual(unaccepted(read, ast(Workers.PutScriptMetadata), "", {}), [
    "exports: echoed but the write has no such field",
    "exportsReconciliation: echoed but the write has no such field",
  ]);
  assert.deepEqual(
    unaccepted(read, ast(Workers.CreateBetaWorkerVersionRequest), "", {}),
    ["exportsReconciliation", "logpush", "observability", "tags", "tailConsumers"].map(
      (key) => `${key}: echoed but the write has no such field`,
    ),
  );
});
