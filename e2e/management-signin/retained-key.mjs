import assert from "node:assert/strict";
import { Effect } from "effect";

/** Install the old source, save a real key account, then upgrade through the public deploy API. */
export const retainWorkOSKey = ({ fixture, request, prefix, app }) =>
  Effect.gen(function* () {
    const path = `${prefix}/apps/${app.id}`;
    yield* request("POST", `${path}/deploy`, {
      files: yield* Effect.promise(fixture.publishedFiles),
    });
    const before = yield* request("GET", path);
    assert.equal(before.requirements.accounts.signIn, undefined);
    const connection = yield* request("POST", `${path}/accounts/user/workos/connections`, {});
    const account = yield* request("POST", `${prefix}/connections/${connection.id}/submit`, {
      method: "apiKey",
      label: "Retained WorkOS key",
      fields: { token: "sk_synthetic-workos-rest" },
    });
    const read = () =>
      request("POST", `${path}/tools/call`, {
        tool: "fixture.read",
        input: { accountId: account.id, input: {} },
      });
    assert.deepEqual(yield* read(), { transport: "rest", retainedKey: true });
    yield* request("POST", `${path}/deploy`, {
      files: yield* Effect.promise(fixture.currentFiles),
    });
    const after = yield* request("GET", path);
    assert.deepEqual(
      after.requirements.accounts.workos,
      before.requirements.accounts.workos,
      "Adding sign-in preserves the entire saved API-key requirement",
    );
    assert.equal(after.requirements.accounts.signIn.cardinality, "many");
    const links = yield* request("GET", `${path}/accounts/user`);
    assert.deepEqual(
      links.filter((link) => link.requirement === "workos").map((link) => link.account.id),
      [account.id],
    );
    assert.deepEqual(yield* read(), { transport: "rest", retainedKey: true });
    return { account, read };
  });
