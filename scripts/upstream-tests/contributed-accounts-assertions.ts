import assert from "node:assert/strict";
import { Cause, Effect } from "effect";

export const forbidden = (effect: any) =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(effect);
    assert.equal(result._tag, "Failure", "the server must refuse this operation");
    assert.equal((Cause.squash(result.cause) as any)._tag, "OrganizationForbidden");
  });
export const params = (app: any, requirement: string, account?: string) => ({
  app: app.id,
  requirement,
  ...(account === undefined ? {} : { account }),
});
