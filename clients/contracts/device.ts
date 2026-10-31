import { Schema } from "effect";
import { Origin } from "./connection.ts";

const Secret = Schema.NonEmptyString.check(
  Schema.makeFilter((value) => value.length <= 16_384 && !/\s/u.test(value)),
);
const Positive = Schema.Int.check(Schema.makeFilter((value) => value > 0));
export const DeviceCredentials = Schema.Struct({
  version: Schema.Literal(1),
  mode: Schema.Literal("device"),
  origin: Origin,
  clientId: Secret,
  accessToken: Secret,
  refreshToken: Secret,
  expiresAt: Positive,
  refreshPending: Schema.optionalKey(Schema.Boolean),
});
export type DeviceCredentials = typeof DeviceCredentials.Type;
export const readDeviceCredentials = Schema.decodeUnknownSync(DeviceCredentials, {
  onExcessProperty: "error",
});
export const NativeAccess = Schema.Struct({
  id: Schema.NonEmptyString,
  userId: Schema.NonEmptyString,
  clientId: Schema.NonEmptyString,
  policy: Schema.Struct({
    kind: Schema.Literal("native"),
    models: Schema.Boolean,
    computer: Schema.NonEmptyString,
    pool: Schema.NonEmptyString,
    toolsOrganization: Schema.optionalKey(Schema.NonEmptyString),
  }),
  expiresAt: Positive,
});
export type NativeAccess = typeof NativeAccess.Type;
export const readNativeAccess = Schema.decodeUnknownSync(NativeAccess);
export const readToken = Schema.decodeUnknownSync(
  Schema.Struct({
    access_token: Secret,
    refresh_token: Secret,
    token_type: Schema.String,
    expires_in: Positive,
    scope: Schema.String,
  }),
);
export const readDeviceAuthorization = Schema.decodeUnknownSync(
  Schema.Struct({
    device_code: Secret,
    user_code: Schema.NonEmptyString,
    verification_uri: Schema.String,
    verification_uri_complete: Schema.String,
    expires_in: Positive,
    interval: Schema.optionalKey(Positive),
  }),
);
export const readClientRegistration = Schema.decodeUnknownSync(
  Schema.Struct({ client_id: Secret }),
);
