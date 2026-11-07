import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

const json = (response, value, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};
const read = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
};
const listen = async (handler) => {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      json(response, { fixtureError: String(error) }, 500);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = new URL("http://127.0.0.1");
  origin.port = String(server.address().port);
  return {
    origin: origin.origin,
    stop: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
};

/** Each data center has its own issuer and API, so a routing mistake fails at the destination. */
export async function startZohoPeopleFixture(scopes) {
  const calls = [];
  const logs = [];
  const forms = [];
  const servers = [];
  const regions = {};
  for (const [id] of [
    ["eu", "eu"],
    ["us", "com"],
    ["in", "in"],
  ]) {
    const challenges = new Map();
    let exchanges = 0;
    let refreshes = 0;
    const api = await listen(async (request, response) => {
      assert.equal(request.headers.authorization, `Zoho-oauthtoken synthetic-${id}-access`);
      const url = new URL(request.url, api.origin);
      const bytes = await read(request);
      const body = new URLSearchParams(bytes.toString());
      calls.push({
        region: id,
        path: url.pathname,
        method: request.method,
        query: Object.fromEntries(url.searchParams),
        body: Object.fromEntries(body),
      });
      if (url.pathname === "/people/api/views")
        return json(response, { response: { status: 0, result: [] } });
      if (url.pathname === "/people/api/timetracker/addtimelog") {
        assert.equal(request.method, "POST");
        assert.equal(url.searchParams.get("jobId"), "job-fixture");
        logs.push({ id: String(logs.length + 1), workItem: url.searchParams.get("workItem") });
        return json(response, { response: { status: 0, result: logs.at(-1) } });
      }
      if (url.pathname === "/people/api/timetracker/gettimelogs") {
        if (url.searchParams.get("user") === "vendor-error")
          return json(response, { response: { status: 1, errors: { code: 9001 } } });
        return json(response, { response: { status: 0, result: logs } });
      }
      if (url.pathname === "/people/api/v3/leave-tracker/leaves") {
        assert.deepEqual(JSON.parse(url.searchParams.get("leave_type_ids")), ["leave-fixture"]);
        return json(response, { status: "success", data: { leaves: [] } });
      }
      if (url.pathname === "/people/api/forms/json/fixture/insertRecord") {
        assert.equal(request.headers["content-type"], "application/x-www-form-urlencoded");
        forms.push(JSON.parse(body.get("inputData")));
        return json(response, { response: { status: 0, result: forms.at(-1) } });
      }
      if (url.pathname === "/people/api/forms/fixture/getRecords")
        return json(response, { response: { status: 0, result: forms } });
      if (url.pathname === "/people/api/attendance") {
        assert.equal(body.get("empId"), "employee-fixture");
        assert.equal(body.get("checkIn"), "07-11-2026 09:00:00");
        return json(response, { response: { status: 0, result: { punched: true } } });
      }
      if (url.pathname === "/people/api/attendance/applyPermission") {
        assert.equal(request.method, "GET");
        return json(response, { status: 0, message: "Success" });
      }
      if (url.pathname === "/people/api/v3/time-attendance/file") {
        const form = await new Response(bytes, {
          headers: { "content-type": request.headers["content-type"] },
        }).formData();
        assert.equal(form.get("file").name, "proof.txt");
        assert.equal(await form.get("file").text(), "fixture upload");
        return json(response, { status: "success", data: { local_file_id: "file-fixture" } });
      }
      if (url.pathname === "/people/api/timetracker/download-file") {
        response.writeHead(200, {
          "content-type": "text/plain",
          "content-disposition": 'attachment; filename="proof.txt"',
        });
        return response.end("fixture download");
      }
      return json(response, { error: "Unexpected fixture route" }, 404);
    });
    const issuer = await listen(async (request, response) => {
      const url = new URL(request.url, issuer.origin);
      if (url.pathname === "/oauth/v2/auth") {
        assert.equal(url.searchParams.get("access_type"), "offline");
        assert.equal(url.searchParams.get("prompt"), "consent");
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        const requested = url.searchParams.get("scope").split(",");
        // This singular spelling in two metadata pages invalidates the entire grant.
        assert.equal(requested.includes("ZOHOPEOPLE.form.READ"), false);
        assert.deepEqual(new Set(requested), new Set(scopes));
        const code = `synthetic-${id}-code-${challenges.size}`;
        challenges.set(code, url.searchParams.get("code_challenge"));
        const callback = new URL(url.searchParams.get("redirect_uri"));
        callback.searchParams.set("state", url.searchParams.get("state"));
        callback.searchParams.set("code", code);
        response.writeHead(302, { location: callback.href });
        return response.end();
      }
      if (url.pathname === "/oauth/v2/token") {
        const fields = new URLSearchParams((await read(request)).toString());
        assert.equal(fields.get("client_id"), "synthetic-people-client");
        assert.equal(fields.get("client_secret"), "synthetic-people-secret");
        if (fields.get("grant_type") === "refresh_token") {
          assert.equal(fields.get("refresh_token"), `synthetic-${id}-refresh`);
          refreshes++;
        } else {
          assert.equal(
            createHash("sha256").update(fields.get("code_verifier")).digest("base64url"),
            challenges.get(fields.get("code")),
          );
          exchanges++;
        }
        return json(response, {
          access_token: `synthetic-${id}-access`,
          token_type: "Bearer",
          refresh_token: `synthetic-${id}-refresh`,
          expires_in: 1,
          scope: scopes.join(","),
          api_domain: "https://synthetic-provider.invalid",
        });
      }
      if (url.pathname === "/oauth/v2/token/revoke") return json(response, { status: "success" });
      return json(response, { error: "Unexpected issuer route" }, 404);
    });
    regions[id] = {
      api: api.origin,
      accounts: issuer.origin,
      exchanges: () => exchanges,
      refreshes: () => refreshes,
    };
    servers.push(api, issuer);
  }
  return {
    regions,
    calls,
    stop: () => Promise.all(servers.map((server) => server.stop())),
  };
}
