import { Schema } from "effect";

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
export const DeclaredChanges = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  stack: logicalName,
  retentionOwner: Schema.NonEmptyString,
  changes: Schema.NonEmptyArray(Schema.Union([BucketDeclaration, SqliteClassDeclaration])),
});

export type DeclaredChanges = typeof DeclaredChanges.Type;
export type BucketDeclaration = typeof BucketDeclaration.Type;
export type SqliteClassDeclaration = typeof SqliteClassDeclaration.Type;

export const decodeDeclaredChanges = Schema.decodeUnknownSync(DeclaredChanges, {
  onExcessProperty: "error",
  errors: "all",
});
