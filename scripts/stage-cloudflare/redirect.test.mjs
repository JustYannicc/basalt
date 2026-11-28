// A stage request is never redirected. Each case below has the recorded-shapes account answer one of
// the stage's own requests, API or registry, with a redirect to a resource the stage does not own.
// The account treats the answer as fetch does for the request's redirect mode, so a request sent
// without `redirect: "error"` is followed exactly as the default transport would follow it. Every
// request the account received is judged by the stage oracle.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stageCloudflare } from "./api.mjs";
import { accountId, outsideCalls, sharedAccount, stageReach } from "./test/stage-reach.mjs";

const prefix = "basalt-180-scale";
const API = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const REGISTRY = `https://registry.cloudflare.com/v2/${accountId}`;
const DIGEST = `sha256:${"a".repeat(64)}`;
const listed = async (api, kind, id) =>
  (await api.inventory([kind]))[kind].find((row) => row.id === id);

const CASES = [
  {
    label: "a listing",
    from: `GET ${API}/workers/scripts?page=1&per_page=100`,
    status: 307,
    to: `${API}/workers/scripts/basalt-production-poolworker/settings`,
    act: (api) => api.inventory(["scripts"]),
  },
  {
    label: "a Worker's settings",
    from: `GET ${API}/workers/scripts/${prefix}-gateway/settings`,
    status: 307,
    to: `${API}/workers/scripts/basalt-production-poolworker/settings`,
    act: (api) => api.settings(`${prefix}-gateway`),
  },
  {
    label: "a Worker delete",
    from: `DELETE ${API}/workers/scripts/${prefix}-gateway?force=true`,
    status: 308,
    to: `${API}/workers/scripts/basalt-production-poolworker?force=true`,
    act: async (api) => api.remove("scripts", await listed(api, "scripts", `${prefix}-gateway`)),
  },
  {
    label: "an application patch",
    from: `PATCH ${API}/containers/applications/own-app`,
    status: 307,
    to: `${API}/containers/applications/prod-app`,
    act: async (api) =>
      api.patch("applications", await listed(api, "applications", "own-app"), {
        max_instances: 1,
      }),
  },
  {
    label: "an application rollout",
    from: `POST ${API}/containers/applications/own-app/rollouts`,
    status: 308,
    to: `${API}/containers/applications/prod-app/rollouts`,
    act: async (api) =>
      api.rollout("applications", await listed(api, "applications", "own-app"), {
        description: "x",
      }),
  },
  {
    label: "an application read-back",
    from: `GET ${API}/containers/applications/own-app`,
    status: 302,
    to: `${API}/containers/applications/prod-app/rollouts`,
    act: async (api) => api.remove("applications", await listed(api, "applications", "own-app")),
  },
  {
    label: "a registry credential",
    from: `POST ${API}/containers/registries/registry.cloudflare.com/credentials`,
    status: 307,
    to: `${API}/workers/scripts/basalt-production-poolworker/settings`,
    act: (api) => api.images(),
  },
  {
    label: "a registry manifest delete",
    from: `DELETE ${REGISTRY}/${prefix}-pool/manifests/${DIGEST}`,
    status: 307,
    to: `${REGISTRY}/basalt-poolcontainer-production/manifests/${DIGEST}`,
    act: async (api) => api.removeImage((await api.images())[0]),
  },
];

for (const { label, from, status, to, act } of CASES)
  test(`a redirect answered to ${label} is never followed`, async () => {
    const fake = sharedAccount(prefix, { redirects: { [from]: { status, location: to } } });
    const reach = stageReach(fake, prefix);
    const api = stageCloudflare({ accountId, token: "t", prefix, fetcher: fake.fetcher });
    await assert.rejects(act(api));
    assert.ok(
      fake.calls.some((call) => `${call.method} ${call.url}` === from),
      "the redirected request was sent",
    );
    assert.deepEqual(outsideCalls(fake, prefix, reach), []);
    assert.deepEqual(
      fake.calls.filter((call) => call.redirect !== "error").map((call) => call.url),
      [],
      "every request refuses redirects",
    );
  });

test("a redirect answer a transport hands back is refused, naming the operation and status", async () => {
  const from = `GET ${API}/workers/scripts/${prefix}-gateway/settings`;
  const location = `${API}/workers/scripts/basalt-production-poolworker/settings`;
  const fake = sharedAccount(prefix, { redirects: { [from]: { status: 307, location } } });
  // A transport that hands redirects back instead of rejecting them, as `redirect: "manual"` does.
  const fetcher = (url, init) => fake.fetcher(url, { ...init, redirect: "manual" });
  const api = stageCloudflare({ accountId, token: "t", prefix, fetcher });
  await assert.rejects(
    api.settings(`${prefix}-gateway`),
    /^Error: Refused: GET workers\/scripts answered a redirect \(HTTP 307\); a stage request is never redirected$/u,
  );
  assert.deepEqual(outsideCalls(fake, prefix), []);
});

test("a request the transport cannot send is refused without the URL it was sent to", async () => {
  const fake = sharedAccount(prefix);
  // Bun rejects a refused redirect naming the full URL, and DNS or TLS failures can too.
  const fetcher = async (url) => {
    throw new TypeError(`UnexpectedRedirect fetching "${url}"`);
  };
  const api = stageCloudflare({ accountId, token: "t", prefix, fetcher });
  const error = await api.inventory(["applications"]).then(
    () => assert.fail("the listing resolved"),
    (rejected) => rejected,
  );
  assert.equal(error.message, "GET containers/applications could not be sent");
  assert.ok(!String(error.stack).includes(accountId));
  assert.equal(error.cause, undefined);
  assert.deepEqual(fake.calls, []);
});
