import * as Workers from "@distilled.cloud/cloudflare/workers";
import { Schema } from "effect";
import type { SqliteClassDeclaration } from "./declared-change-schema.ts";
import type { ClassContent, ClassObservation } from "./declared-class-contract.ts";
import { BarrierRefusal, canonical, digest, type ModulePart } from "./manifest.ts";

export const contentDigest = (content: ClassContent) =>
  digest(
    canonical({
      mainModule: content.mainModule,
      files: [...content.files]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((file) => ({ name: file.name, type: file.type, sha256: digest(file.bytes) })),
    }),
  );

/** Baseline modules stay byte-identical except an inert re-export appended to their entry module. No candidate code enters this deployment. */
export function expansionContent(
  content: ClassContent,
  entry: SqliteClassDeclaration,
): ClassContent {
  const module = `__basalt_declared_${digest(canonical(entry)).slice(0, 16)}.mjs`;
  const names = new Set(content.files.map((file) => file.name));
  const main = content.files.find((file) => file.name === content.mainModule);
  if (
    !main ||
    names.size !== content.files.length ||
    names.has(module) ||
    main.type !== "application/javascript+module" ||
    content.mainModule.includes("\\") ||
    content.mainModule.startsWith("/") ||
    content.mainModule.split("/").includes("..")
  )
    throw new BarrierRefusal("declared-class-baseline-modules-unsupported", entry.fqn);
  const path = "../".repeat(content.mainModule.split("/").length - 1) + module;
  const suffix = new TextEncoder().encode(
    `\nexport { ${[...entry.newSqliteClasses].sort().join(", ")} } from ${JSON.stringify(`./${path}`)};\n`,
  );
  const files: ModulePart[] = content.files.map((file) =>
    file === main
      ? { ...file, bytes: new Uint8Array([...file.bytes, ...suffix]) }
      : { ...file, bytes: new Uint8Array(file.bytes) },
  );
  files.push({
    name: module,
    type: "application/javascript+module",
    bytes: new TextEncoder().encode(
      "import { DurableObject } from 'cloudflare:workers';\n" +
        [...entry.newSqliteClasses]
          .sort()
          .map((name) => `export class ${name} extends DurableObject {}\n`)
          .join(""),
    ),
  });
  return { mainModule: content.mainModule, files };
}

export function expansionRequest(
  baseline: ClassObservation,
  content: ClassContent,
  entry: SqliteClassDeclaration,
  newTag: string,
  tags: readonly string[],
  marker: string,
): Workers.PutScriptRequest {
  const settings = baseline.settings;
  if (
    settings.exports ||
    settings.cacheOptions ||
    settings.usageModel === "bundled" ||
    settings.usageModel === "unbound"
  )
    throw new BarrierRefusal("declared-class-baseline-settings-unsupported", entry.fqn);
  const withoutNull = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(withoutNull)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, item]) => item != null)
              .map(([key, item]) => [key, withoutNull(item)]),
          )
        : value;
  const metadata = Schema.decodeUnknownSync(Schema.toType(Workers.PutScriptMetadata), {
    onExcessProperty: "error",
  })(
    withoutNull({
      mainModule: content.mainModule,
      compatibilityDate: settings.compatibilityDate ?? undefined,
      compatibilityFlags: settings.compatibilityFlags ?? undefined,
      bindings: [
        ...(settings.bindings ?? []).map((binding) => ({
          type: "inherit" as const,
          name: binding.name,
        })),
        ...entry.addedBindings.map(({ location, ...binding }) => binding),
      ],
      migrations: {
        oldTag: baseline.migrationTag,
        newTag,
        newSqliteClasses: [...entry.newSqliteClasses],
      },
      tags: [...tags],
      annotations: { ...settings.annotations, workersMessage: marker },
      observability: settings.observability ?? undefined,
      limits: settings.limits ?? undefined,
      placement: settings.placement ?? undefined,
      logpush: settings.logpush ?? undefined,
      tailConsumers: settings.tailConsumers ?? undefined,
    }),
  );
  return {
    accountId: baseline.accountId,
    scriptName: baseline.scriptName,
    bindingsInherit: "strict",
    metadata,
    files: content.files.map(
      (file) => new File([new Uint8Array(file.bytes)], file.name, { type: file.type }),
    ),
  };
}

export const payloadDigest = (request: Workers.PutScriptRequest, content: ClassContent) =>
  digest(
    canonical({
      target: [request.accountId, request.scriptName],
      bindingsInherit: request.bindingsInherit,
      metadata: request.metadata,
      content: contentDigest(content),
    }),
  );
