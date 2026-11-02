import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";

/** Synthetic Slack sign-in and metadata endpoints. No messages or files are exposed. */
export async function startSlackHealthFixture(getAnswer, calls) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (["/oauth/v2/authorize", "/oauth/authorize"].includes(url.pathname)) {
      const callback = new URL(url.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", url.searchParams.get("state"));
      callback.searchParams.set("code", url.searchParams.get("fixture_user"));
      response.writeHead(302, { location: callback.href });
      response.end();
      return;
    }
    if (url.pathname === "/v1/oauth/token") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          access_token: "synthetic-miro",
          token_type: "bearer",
          user_id: "M0100FIXTURE",
        }),
      );
      return;
    }
    if (url.pathname === "/v1/oauth-token") {
      assert.equal(request.headers.authorization, "Bearer synthetic-miro");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ user: { id: "M0100FIXTURE", name: "Miro fixture" } }));
      return;
    }
    if (url.pathname === "/api/oauth.v2.access") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const code = new URLSearchParams(raw).get("code");
      assert.ok(["synthetic-one", "synthetic-two"].includes(code));
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          app_id: "A0100FIXTURE",
          authed_user: {
            id: code === "synthetic-one" ? "U0100FIRST1" : "U0100OTHER2",
            access_token: code,
            token_type: "user",
            scope: "users:read,users.profile:read",
          },
          team: { id: "T0100FIXTURE", name: "Fixture workspace" },
          enterprise: null,
          is_enterprise_install: false,
        }),
      );
      return;
    }
    const answer = getAnswer();
    const token = request.headers.authorization?.replace(/^Bearer /, "");
    assert.ok(["synthetic-one", "synthetic-two"].includes(token));
    assert.ok(["/api/auth.test", "/api/users.profile.get"].includes(url.pathname), "metadata only");
    calls.push({
      path: url.pathname,
      method: request.method,
      user: url.searchParams.get("user"),
    });
    response.setHeader("content-type", "application/json");
    if (answer.kind === "profile-body" && url.pathname.endsWith("users.profile.get")) {
      response.end(JSON.stringify(answer.body));
      return;
    }
    if (
      (answer.kind === "auth-error" && url.pathname.endsWith("auth.test")) ||
      (answer.kind === "profile-error" && url.pathname.endsWith("users.profile.get"))
    ) {
      response.statusCode = answer.status ?? 200;
      response.end(JSON.stringify({ ok: false, error: answer.error }));
    } else if (url.pathname.endsWith("auth.test")) {
      response.end(
        JSON.stringify({
          ok: true,
          user_id: token === "synthetic-one" ? "U0100FIRST1" : "U0100OTHER2",
          user: "fixture-person",
          url: "https://fixture.slack.com/",
        }),
      );
    } else {
      const profile =
        answer.kind === "optional"
          ? {
              display_name: null,
              real_name: "Synthetic Real",
              email: null,
              image_192: "javascript:bad",
            }
          : {
              display_name: "Synthetic Person",
              real_name: "Synthetic Real",
              email: "person@example.test",
              image_192: "https://example.test/avatar.png",
            };
      response.end(JSON.stringify({ ok: true, profile }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    stop: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
