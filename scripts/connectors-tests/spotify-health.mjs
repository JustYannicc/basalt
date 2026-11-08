import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Effect } from "effect";
import source from "../../src/catalog/spotify.json" with { type: "json" };

// Spotify's `GET /v1/me`: most accounts have an opaque user id, a display name that may be null,
// and an email with the user-read-email scope.
let me = { id: "spotify-user-synthetic", display_name: "Ada", email: "ada@example.test" };
const paths = [];
const peer = Bun.serve({
  port: 0,
  fetch(request) {
    paths.push(new URL(request.url).pathname);
    if (request.headers.get("authorization") !== "Bearer synthetic-good")
      return new Response("Unauthorized", { status: 401 });
    return Response.json(me);
  },
});
const directory = await mkdtemp(resolve(".upstream/packages/apps/.spotify-health-"));
try {
  for (const file of source.files.filter(
    (file) => /\.(ts|json)$/.test(file.path) && file.path !== "package.json",
  )) {
    let content = file.content.replaceAll(
      "https://api.spotify.com",
      peer.url.toString().replace(/\/$/, ""),
    );
    if (file.path === "index.ts")
      content =
        content.slice(0, content.indexOf("export default defineApp")) + "export { spotify };\n";
    await writeFile(join(directory, file.path), content);
  }
  const { spotify } = await import(join(directory, "index.ts"));
  const check = (token = "synthetic-good") =>
    Effect.runPromise(
      spotify.health.run({
        account: { id: "acc_synthetic", method: "oauth", fields: { access_token: token } },
        fetch: (input, init) => {
          assert.equal(new URL(input).origin, peer.url.origin);
          return fetch(input, init);
        },
        signal: new AbortController().signal,
        deadline: Date.now() + 10_000,
      }),
    );
  const profileUrl = `https://open.spotify.com/user/${me.id}`;
  const long = `${"x".repeat(250)}@example.test`;
  for (const [email, displayName, expected] of [
    ["ada@example.test", "Ada", { email: "ada@example.test", displayName: "Ada" }],
    ["  ada@example.test ", "  Ada  ", { email: "ada@example.test", displayName: "Ada" }],
    [undefined, "Ada", { displayName: "Ada" }],
    [null, null, {}],
    ["", "   ", {}],
    [42, [], {}],
    // A cut email would name someone else, so one past the host's 255 characters is left out.
    [long, "x".repeat(300), { displayName: "x".repeat(255) }],
  ]) {
    me = {
      id: "spotify-user-synthetic",
      ...(email === undefined ? {} : { email }),
      display_name: displayName,
    };
    const { accountInfo } = await check();
    assert.deepEqual(accountInfo, { externalId: me.id, ...expected, profileUrl });
    assert.ok(!("username" in accountInfo), "the opaque user id never names the account");
  }
  await assert.rejects(check("synthetic-rejected"));
  assert.ok(paths.every((path) => path === "/v1/me"));
  console.log(`Spotify synthetic health checks passed; ${paths.length} reads of /v1/me`);
} finally {
  peer.stop(true);
  await rm(directory, { recursive: true, force: true });
}
