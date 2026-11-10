import { Schema } from "effect";
import { RuntimeCreateDeclaration } from "./runtime-create-schema.ts";

const logicalName = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_/-]*$/u));
const className = Schema.String.check(Schema.isPattern(/^[A-Za-z_$][A-Za-z0-9_$]*$/u));
const empty = Schema.Tuple([]);
const retained = Schema.Struct({
  data: Schema.Literal(true),
  nativeStateRow: Schema.Literal(true),
  recoveryDescriptor: Schema.Literal(true),
});

export const BucketDeclaration = Schema.Struct({
  action: Schema.Literal("create-bucket"),
  type: Schema.Literal("Cloudflare.R2.Bucket"),
  fqn: logicalName,
  props: Schema.Struct({
    jurisdiction: Schema.Literal("eu"),
    storageClass: Schema.Literal("Standard"),
    publicAccess: Schema.Literal(false),
    forceDestroy: Schema.Literal(false),
    domains: empty,
    cors: empty,
    lifecycleRules: empty,
  }),
  removalPolicy: Schema.Literal("retain"),
  retention: retained,
});

export const D1Declaration = Schema.Struct({
  action: Schema.Literal("create-d1-database"),
  type: Schema.Literal("Cloudflare.D1Database"),
  fqn: logicalName,
  props: Schema.Struct({
    name: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/u)),
    jurisdiction: Schema.Literal("eu"),
  }),
  removalPolicy: Schema.Literal("retain"),
  retention: retained,
});

export const SqliteClassDeclaration = Schema.Struct({
  action: Schema.Literal("add-sqlite-class"),
  type: Schema.Literal("Cloudflare.Worker"),
  fqn: logicalName,
  newSqliteClasses: Schema.NonEmptyArray(className),
  addedBindings: Schema.NonEmptyArray(
    Schema.Struct({
      type: Schema.Literal("durable_object_namespace"),
      name: className,
      className,
      location: Schema.Literal("local"),
    }),
  ),
  retention: retained,
});

/** Reviewed intent has no field through which an author can supply observed authority. */
const LegacyDeclaredChanges = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  stack: logicalName,
  retentionOwner: Schema.NonEmptyString,
  changes: Schema.NonEmptyArray(
    Schema.Union([BucketDeclaration, D1Declaration, SqliteClassDeclaration]),
  ),
});

export const DeclaredChanges = Schema.Union([
  LegacyDeclaredChanges,
  Schema.Struct({
    schemaVersion: Schema.Literal(2),
    stack: logicalName,
    retentionOwner: Schema.NonEmptyString,
    changes: Schema.NonEmptyArray(
      Schema.Union([
        BucketDeclaration,
        D1Declaration,
        SqliteClassDeclaration,
        RuntimeCreateDeclaration,
      ]),
    ),
  }),
]);

export type DeclaredChanges = typeof DeclaredChanges.Type;
export type BucketDeclaration = typeof BucketDeclaration.Type;
export type SqliteClassDeclaration = typeof SqliteClassDeclaration.Type;

const decode = Schema.decodeUnknownSync(DeclaredChanges, {
  onExcessProperty: "error",
  errors: "all",
});
export function decodeDeclaredChanges<T extends { schemaVersion: 1 }>(
  value: T,
): typeof LegacyDeclaredChanges.Type;
export function decodeDeclaredChanges(value: unknown): DeclaredChanges;
export function decodeDeclaredChanges(value: unknown) {
  return decode(value);
}

export type D1Declaration = typeof D1Declaration.Type;
