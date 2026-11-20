import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import type { StageScope } from "./stage-writes.ts";
import { createContainerApplicationName } from "alchemy/Cloudflare/Containers";
import { InstanceId } from "alchemy/InstanceId";
import { StackContext } from "alchemy/StackContext";
import { Stage } from "alchemy/Stage";
import { isRehearsalStage, rehearsalStack, stageOwnsName } from "./rehearsal-stage.ts";
import { TEARDOWN_NOT_CHECKED, teardownStage } from "./stage-teardown.ts";
import { install, WireRefused, type WireGuardConfig } from "./wire-guard.ts";

const ACCOUNT = "1".repeat(32);
const OTHER_ACCOUNT = "2".repeat(32);
const digest = (n: number) => `sha256:${String(n).repeat(64)}`;
const scope: StageScope = {
  stack: "basalt-rehearsal",
  stage: "test-rehearsal-2",
  label: "rehearsal-2",
  databases: [],
  owned: [],
  teardown: true,
  accountId: ACCOUNT,
};

interface Fake {
  applications: { id: string; name: string }[];
  /** `<account>/<name>` → tag → digest. */
  repositories: Record<string, Record<string, string>>;
  /** `<account>/<name>` → digests stored with no tag: an index's platform manifests, or a push by digest. */
  untagged?: Record<string, string[]>;
  /** An index's digest → the manifests it names. */
  indexes?: Record<string, string[]>;
  /** An application or manifest digest whose delete answers 500. */
  failDelete?: string;
  /** The permissions each registry credential request asked for. */
  permissions?: unknown[];
  sent: string[];
}

const fake = (overrides: Partial<Fake> = {}): Fake => ({
  applications: [
    { id: "app-own-cell", name: "basalt-test-rehearsal-2-pool-runtime-blue" },
    {
      id: "app-own-pool",
      name: "basalt-rehearsal-poolcontainer-test-rehearsal-2-abcdefghijklmnop",
    },
    { id: "app-20", name: "basalt-test-rehearsal-20-pool-runtime-blue" },
    {
      id: "app-20-pool",
      name: "basalt-rehearsal-poolcontainer-test-rehearsal-20-abcdefghijklmnop",
    },
    { id: "app-3", name: "basalt-test-rehearsal-3-pool-runtime-blue" },
    { id: "app-production", name: "basalt-production-cell-a" },
    { id: "app-root", name: "basalt-poolcontainer-production" },
  ],
  repositories: {
    // Two tags on one digest: deleting the digest removes both.
    [`${ACCOUNT}/basalt-rehearsal-poolcontainer-test-rehearsal-2-abcdefghijklmnop`]: {
      a: digest(1),
      b: digest(1),
      c: digest(2),
    },
    [`${ACCOUNT}/basalt-rehearsal-poolcontainer-test-rehearsal-20-abcdefghijklmnop`]: {
      a: digest(3),
    },
    [`${ACCOUNT}/basalt-pool-production`]: { latest: digest(4) },
    [`${OTHER_ACCOUNT}/basalt-rehearsal-poolcontainer-test-rehearsal-2-abcdefghijklmnop`]: {
      a: digest(5),
    },
    [`${ACCOUNT}/basalt-rehearsal-poolcontainer-test-rehearsal-2-abcdefghijklmnop/nested`]: {
      a: digest(6),
    },
  },
  sent: [],
  ...overrides,
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** Cloudflare's API and registry as the teardown sees them; any other host throws. */
const cloudflare =
  (state: Fake): typeof fetch =>
  async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const method = request.method;
    state.sent.push(`${method} ${url.host}${url.pathname}`);
    if (url.host === "api.cloudflare.com") {
      const apps = `/client/v4/accounts/${ACCOUNT}/containers/applications`;
      if (method === "GET" && url.pathname === apps)
        return json({ success: true, result: state.applications });
      const one = new RegExp(`^${apps}/([^/]+)$`, "u").exec(url.pathname)?.[1];
      const app = state.applications.find((entry) => entry.id === one);
      if (one && method === "GET")
        return app
          ? json({ success: true, result: { ...app, durable_objects: { namespace_id: "ns" } } })
          : json({ success: false, result: null }, 404);
      if (one && method === "DELETE") {
        if (state.failDelete === one) return json({ success: false }, 500);
        state.applications = state.applications.filter((entry) => entry.id !== one);
        return json({ success: true, result: null }, app ? 200 : 404);
      }
      if (
        method === "POST" &&
        url.pathname ===
          `/client/v4/accounts/${ACCOUNT}/containers/registries/registry.cloudflare.com/credentials`
      ) {
        state.permissions = [
          ...(state.permissions ?? []),
          ((await request.json()) as { permissions?: unknown }).permissions,
        ];
        return json({ success: true, result: { username: "u", password: "p" } });
      }
    }
    if (url.host === "registry.cloudflare.com") {
      if (url.pathname === "/v2/_catalog")
        return json({ repositories: Object.keys(state.repositories) });
      const tags = /^\/v2\/(.+)\/tags\/list$/u.exec(url.pathname)?.[1];
      if (tags && method === "GET") {
        const repository = state.repositories[tags];
        return repository
          ? json({ name: tags, tags: Object.keys(repository) })
          : json({ errors: [] }, 404);
      }
      const manifest = /^\/v2\/(.+)\/manifests\/([^/]+)$/u.exec(url.pathname);
      const repository = manifest ? state.repositories[manifest[1]!] : undefined;
      const stored = manifest ? (state.untagged?.[manifest[1]!] ?? []) : [];
      if (manifest && repository && method === "GET") {
        const reference = decodeURIComponent(manifest[2]!);
        const found =
          repository[reference] ??
          (Object.values(repository).includes(reference) || stored.includes(reference)
            ? reference
            : undefined);
        if (!found) return json({ errors: [] }, 404);
        const children = state.indexes?.[found];
        return json(
          children
            ? {
                mediaType: "application/vnd.oci.image.index.v1+json",
                manifests: children.map((child) => ({ digest: child })),
              }
            : { mediaType: "application/vnd.oci.image.manifest.v1+json", layers: [] },
          200,
          { "docker-content-digest": found },
        );
      }
      if (manifest && repository && method === "DELETE") {
        if (state.failDelete === manifest[2]) return json({ errors: [] }, 500);
        for (const [tag, value] of Object.entries(repository))
          if (value === manifest[2]) delete repository[tag];
        if (state.untagged?.[manifest[1]!])
          state.untagged[manifest[1]!] = stored.filter((entry) => entry !== manifest[2]);
        return new Response(null, { status: 202 });
      }
    }
    throw new Error(`the stand-in has no answer for ${method} ${url.host}${url.pathname}`);
  };

/** Runs `body` with the wire guard installed over the stand-in, as the entry runs a teardown. */
const underGuard = async <A>(
  state: Fake,
  config: WireGuardConfig,
  body: (fetcher: typeof fetch) => Promise<A>,
  wrap: (fetcher: typeof fetch) => typeof fetch = (fetcher) => fetcher,
) => {
  const original = globalThis.fetch;
  globalThis.fetch = wrap(cloudflare(state));
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const guard = yield* install(config);
          return yield* Effect.promise(() =>
            body(guard.fetch).then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            ),
          );
        }),
      ),
    );
  } finally {
    globalThis.fetch = original;
  }
};
const input = (stage = "test-rehearsal-2") => ({ accountId: ACCOUNT, token: "synthetic", stage });
const writes = (state: Fake) =>
  state.sent.filter((line) => !line.startsWith("GET ") && !line.startsWith("HEAD "));

test("a stage owns a name only by its whole shape, never by a prefix or a token", () => {
  const suffix = "abcdefghijklmnop";
  for (const name of [
    "basalt-test-rehearsal-2-pool-runtime-blue",
    "basalt-test-rehearsal-2-pool-runtime-green",
    `basalt-rehearsal-poolcontainer-test-rehearsal-2-${suffix}`,
  ])
    assert.equal(stageOwnsName(name, "test-rehearsal-2"), true, name);
  for (const name of [
    // A stage whose number starts the same, and another rehearsal stage.
    "basalt-test-rehearsal-20-pool-runtime-blue",
    `basalt-rehearsal-poolcontainer-test-rehearsal-20-${suffix}`,
    "basalt-test-rehearsal-3-pool-runtime-blue",
    // Stages that only begin or end with the token: their own fleet and Alchemy names.
    "basalt-test-rehearsal-2-b-pool-runtime-blue",
    "basalt-test-rehearsal-2--pool-runtime-blue",
    `basalt-rehearsal-poolcontainer-test-rehearsal-2-b-${suffix}`,
    `basalt-rehearsal-poolcontainer-test-x-test-rehearsal-2-${suffix}`,
    // Near misses of the shapes, and production's names.
    "basalt-test-rehearsal-2-pool-runtime-red",
    "basalt-test-rehearsal-2-cell-a",
    `basalt-rehearsal-poolcontainer-test-rehearsal-2-${suffix.slice(1)}`,
    `basalt-rehearsal-poolcontainer-test-rehearsal-2-${suffix.toUpperCase()}`,
    "basalt-production-test-rehearsal-2-x",
    "basalt-production-pool-runtime-blue",
    "basalt-poolcontainer-production",
  ])
    assert.equal(stageOwnsName(name, "test-rehearsal-2"), false, name);
  assert.equal(stageOwnsName("basalt-test-pr-7-pool-runtime-blue", "test-pr-7"), false);
});

test("Alchemy's name for the pool container carries every accepted rehearsal stage whole", async () => {
  const name = (stage: string) =>
    Effect.runPromise(
      createContainerApplicationName("PoolContainer", undefined).pipe(
        Effect.provideService(StackContext, { name: rehearsalStack } as never),
        Effect.provideService(Stage, stage),
        Effect.provideService(InstanceId, "ab".repeat(16)),
      ),
    );
  for (const stage of ["test-rehearsal-1", "test-rehearsal-9"]) {
    // The application and its registry repository both take this name.
    const own = await name(stage);
    assert.match(own, new RegExp(`^${rehearsalStack}-poolcontainer-${stage}-[a-z2-7]{16}$`, "u"));
    assert.equal(stageOwnsName(own, stage), true, own);
  }
  // From ten on the name is truncated past the token, so the entry refuses those stages.
  assert.doesNotMatch(await name("test-rehearsal-10"), /test-rehearsal-10/u);
  assert.equal(isRehearsalStage("test-rehearsal-10"), false);
});

test("a teardown deletes only the stage's own applications and images, then proves them gone", async () => {
  const state = fake();
  const result = await underGuard(state, { stage: scope }, (fetcher) =>
    teardownStage("delete", input(), fetcher),
  );
  assert.ok("value" in result, String((result as { error?: unknown }).error));
  assert.deepEqual(state.permissions, [["pull", "push"]]);
  assert.deepEqual(result.value, {
    applications: [
      "basalt-test-rehearsal-2-pool-runtime-blue",
      "basalt-rehearsal-poolcontainer-test-rehearsal-2-abcdefghijklmnop",
    ],
    repositories: [`${ACCOUNT}/basalt-rehearsal-poolcontainer-test-rehearsal-2-abcdefghijklmnop`],
    manifests: 2,
  });
  const registry = `registry.cloudflare.com/v2/${ACCOUNT}/basalt-rehearsal-poolcontainer-test-rehearsal-2-abcdefghijklmnop`;
  const apps = `api.cloudflare.com/client/v4/accounts/${ACCOUNT}/containers`;
  assert.deepEqual(writes(state), [
    `DELETE ${apps}/applications/app-own-cell`,
    `DELETE ${apps}/applications/app-own-pool`,
    `POST ${apps}/registries/registry.cloudflare.com/credentials`,
    `DELETE ${registry}/manifests/${digest(1)}`,
    `DELETE ${registry}/manifests/${digest(2)}`,
  ]);
  // Everything else is where it was.
  assert.deepEqual(
    state.applications.map((app) => app.id),
    ["app-20", "app-20-pool", "app-3", "app-production", "app-root"],
  );
  assert.deepEqual(
    Object.entries(state.repositories)
      .filter(([, tags]) => Object.keys(tags).length)
      .map(([name]) => name),
    [
      `${ACCOUNT}/basalt-rehearsal-poolcontainer-test-rehearsal-20-abcdefghijklmnop`,
      `${ACCOUNT}/basalt-pool-production`,
      `${OTHER_ACCOUNT}/basalt-rehearsal-poolcontainer-test-rehearsal-2-abcdefghijklmnop`,
      `${ACCOUNT}/basalt-rehearsal-poolcontainer-test-rehearsal-2-abcdefghijklmnop/nested`,
    ],
  );
});

test("an index's platform manifests are deleted with it; a push by digest alone is not seen", async () => {
  const own = `${ACCOUNT}/basalt-rehearsal-poolcontainer-test-rehearsal-2-abcdefghijklmnop`;
  const state = fake({
    applications: [],
    repositories: { [own]: { multi: digest(7) } },
    indexes: { [digest(7)]: [digest(8), digest(9)] },
    untagged: { [own]: [digest(8), digest(9), digest(0)] },
  });
  const result = await underGuard(state, { stage: scope }, (fetcher) =>
    teardownStage("delete", input(), fetcher),
  );
  assert.ok("value" in result, String((result as { error?: unknown }).error));
  assert.equal(result.value.manifests, 3);
  const registry = `registry.cloudflare.com/v2/${own}`;
  assert.deepEqual(
    writes(state).filter((line) => line.includes("/manifests/")),
    [7, 8, 9].map((n) => `DELETE ${registry}/manifests/${digest(n)}`),
  );
  // No tag names it, so the registry never lists it: it stays, and the summary says so.
  assert.deepEqual(state.untagged?.[own], [digest(0)]);
  assert.match(TEARDOWN_NOT_CHECKED, /pushed by digest alone, never tagged, is not checked/u);
});

test("a teardown of production or any non-rehearsal stage refuses before anything is sent", async () => {
  for (const stage of ["production", "test-pr-7", "test-rehearsal-0", "test-rehearsal-2x", ""]) {
    const state = fake();
    const result = await underGuard(state, { stage: { ...scope, stage } }, (fetcher) =>
      teardownStage("delete", input(stage), fetcher),
    );
    assert.ok("error" in result, stage);
    assert.match(String(result.error), /test-rehearsal-<n>/u);
    assert.deepEqual(state.sent, [], stage);
  }
});

test("the guard refuses another stage's or production's delete, even if the teardown sent one", async () => {
  const state = fake();
  const api = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/containers/applications`;
  const registry = `https://registry.cloudflare.com/v2/${ACCOUNT}`;
  const outcomes = await underGuard(state, { stage: scope }, async (fetcher) => {
    const results: string[] = [];
    for (const url of [
      `${api}/app-20`,
      `${api}/app-20-pool`,
      `${api}/app-production`,
      `${api}/app-root`,
      // Gone already: an application Cloudflare cannot name is not proven the stage's.
      `${api}/app-missing`,
      `${registry}/basalt-rehearsal-poolcontainer-test-rehearsal-20-abcdefghijklmnop/manifests/${digest(3)}`,
      `${registry}/basalt-pool-production/manifests/${digest(4)}`,
      // The stage's repository name, in another account's path.
      `https://registry.cloudflare.com/v2/${OTHER_ACCOUNT}/basalt-rehearsal-poolcontainer-test-rehearsal-2-abcdefghijklmnop/manifests/${digest(5)}`,
      // The stage's own application, at another account or on a host that would vouch for itself.
      `https://api.cloudflare.com/client/v4/accounts/${OTHER_ACCOUNT}/containers/applications/app-own-cell`,
      `https://other.example/client/v4/accounts/${ACCOUNT}/containers/applications/app-own-cell`,
    ])
      results.push(
        await fetcher(url, { method: "DELETE", headers: { authorization: "Bearer synthetic" } })
          .then((response) => `sent ${response.status}`)
          .catch((error: unknown) =>
            error instanceof WireRefused ? `refused ${error.field}` : String(error),
          ),
      );
    return results;
  });
  assert.ok("value" in outcomes);
  assert.deepEqual(outcomes.value, [
    "refused name",
    "refused name",
    "refused name",
    "refused name",
    "refused name",
    "refused repository",
    "refused repository",
    "refused account",
    "refused account",
    "refused host",
  ]);
  // Only the reads that placed each application; no delete left the process, and no read went
  // to another account or host.
  assert.deepEqual(writes(state), []);
  assert.ok(
    state.sent.every((line) => !line.includes(OTHER_ACCOUNT) && !line.includes("other.example")),
  );
  assert.equal(state.applications.length, 7);
});

test("a registry delete outside a rehearsal teardown's scope is refused, production's included", async () => {
  for (const [label, config, host = "registry.cloudflare.com"] of [
    ["production (no stage scope)", {}],
    ["production, the host spelled with a trailing dot", {}, "registry.cloudflare.com."],
    [
      "the stage, the host spelled with a trailing dot",
      { stage: scope },
      "registry.cloudflare.com.",
    ],
    ["the stage outside a teardown", { stage: { ...scope, teardown: false } }],
    ["a PR stage", { stage: { ...scope, stage: "test-pr-7", label: "pr-7" } }],
  ] as const) {
    const url = `https://${host}/v2/${ACCOUNT}/basalt-rehearsal-poolcontainer-test-rehearsal-2-abcdefghijklmnop/manifests/${digest(1)}`;
    const state = fake();
    const outcome = await underGuard(state, config, (fetcher) =>
      fetcher(url, { method: "DELETE" }).then(
        (response) => `sent ${response.status}`,
        (error: unknown) => (error instanceof WireRefused ? "refused" : String(error)),
      ),
    );
    assert.deepEqual([label, "value" in outcome && outcome.value], [label, "refused"]);
    assert.deepEqual(state.sent, [], label);
  }
});

test("a teardown's proof read follows no redirect, and writes nothing to the registry but its deletes", async () => {
  const one = `/client/v4/accounts/${ACCOUNT}/containers/applications/`;
  // The proof read is sent around the guard; it must not follow a redirect to an unchecked address.
  const redirects: string[] = [];
  // Read without building a Request: that would use up a body the guard has already handed on.
  const seen = (input: RequestInfo | URL, init?: RequestInit) => ({
    method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
    path: new URL(input instanceof Request ? input.url : String(input)).pathname,
    redirect: init?.redirect ?? (input instanceof Request ? input.redirect : "follow"),
  });
  const recording =
    (fetcher: typeof fetch): typeof fetch =>
    async (input, init) => {
      const { method, path, redirect } = seen(input, init);
      if (method === "GET" && path.startsWith(one)) redirects.push(redirect);
      return fetcher(input, init);
    };
  const state = fake();
  const done = await underGuard(
    state,
    { stage: scope },
    (fetcher) => teardownStage("delete", input(), fetcher),
    recording,
  );
  assert.ok("value" in done, String("error" in done && done.error));
  assert.ok(redirects.length > 0);
  assert.deepEqual(new Set(redirects), new Set(["manual"]));
  // Answered with a redirect, the proof names nothing, so the delete is refused and never sent.
  const moved = fake();
  const redirected =
    (fetcher: typeof fetch): typeof fetch =>
    async (input, init) => {
      const { method, path } = seen(input, init);
      if (method === "GET" && path === `${one}app-own-cell`)
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.invalid/" },
        });
      return fetcher(input, init);
    };
  const refused = await underGuard(
    moved,
    { stage: scope },
    (fetcher) => teardownStage("delete", input(), fetcher),
    redirected,
  );
  assert.ok("error" in refused);
  assert.ok(!moved.sent.some((line) => line.startsWith("DELETE") && line.endsWith("app-own-cell")));
  // Inside the teardown's scope, a registry write that is not a delete is refused too.
  const own = `https://registry.cloudflare.com/v2/${ACCOUNT}/basalt-rehearsal-poolcontainer-test-rehearsal-2-abcdefghijklmnop/manifests/${digest(1)}`;
  for (const method of ["PUT", "POST", "PATCH"]) {
    const images = fake();
    const outcome = await underGuard(images, { stage: scope }, (fetcher) =>
      fetcher(own, { method, body: "{}" }).then(
        (response) => `sent ${response.status}`,
        (error: unknown) => (error instanceof WireRefused ? "refused" : String(error)),
      ),
    );
    assert.deepEqual([method, "value" in outcome && outcome.value], [method, "refused"]);
    assert.deepEqual(images.sent, [], method);
  }
});

test("a teardown stops at its first failed delete", async () => {
  const apps = fake({ failDelete: "app-own-cell" });
  const failed = await underGuard(apps, { stage: scope }, (fetcher) =>
    teardownStage("delete", input(), fetcher),
  );
  assert.ok("error" in failed);
  assert.match(String(failed.error), /Container application delete failed with HTTP 500/u);
  // The next application and every registry request were never sent.
  assert.deepEqual(writes(apps), [
    `DELETE api.cloudflare.com/client/v4/accounts/${ACCOUNT}/containers/applications/app-own-cell`,
  ]);

  const images = fake({ failDelete: digest(1) });
  const stopped = await underGuard(images, { stage: scope }, (fetcher) =>
    teardownStage("delete", input(), fetcher),
  );
  assert.ok("error" in stopped);
  assert.match(String(stopped.error), /Registry manifest delete failed with HTTP 500/u);
  assert.equal(writes(images).filter((line) => line.includes("/manifests/")).length, 1);
});

test("the absence check refuses while any of the stage's applications or images remain", async () => {
  const withApplication = fake({ repositories: {} });
  const left = await underGuard(withApplication, { stage: scope }, (fetcher) =>
    teardownStage("verify", input(), fetcher),
  );
  assert.ok("error" in left);
  assert.match(String(left.error), /2 of the stage's container applications remain/u);

  const withImage = fake({
    applications: [{ id: "app-20", name: "basalt-test-rehearsal-20-pool-runtime-blue" }],
  });
  const tagged = await underGuard(withImage, { stage: scope }, (fetcher) =>
    teardownStage("verify", input(), fetcher),
  );
  assert.ok("error" in tagged);
  assert.match(String(tagged.error), /The stage's tagged registry images remain/u);
  // The check alone asks the registry for no right to delete.
  assert.deepEqual(withImage.permissions, [["pull"]]);
  // The check deletes nothing.
  for (const state of [withApplication, withImage])
    assert.deepEqual(
      writes(state).filter((line) => line.startsWith("DELETE")),
      [],
    );

  const clean = fake({
    applications: [{ id: "app-20", name: "basalt-test-rehearsal-20-pool-runtime-blue" }],
    repositories: {
      [`${ACCOUNT}/basalt-rehearsal-poolcontainer-test-rehearsal-20-abcdefghijklmnop`]: {
        a: digest(3),
      },
    },
  });
  const verified = await underGuard(clean, { stage: scope }, (fetcher) =>
    teardownStage("verify", input(), fetcher),
  );
  assert.deepEqual(verified, { value: { applications: [], repositories: [], manifests: 0 } });
});

test("the entry refuses a teardown of production or a non-rehearsal stage before it loads anything", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const entry = fileURLToPath(new URL("./deploy.ts", import.meta.url));
  for (const [stage, refusal] of [
    // Outside CI, production refuses before it gets to say it is never destroyed.
    ["production", /Production releases run only in GitHub Actions/u],
    ["test-pr-7", /A teardown runs only on a test-rehearsal-<n> stage/u],
    ["test-rehearsal-2x", /A rehearsal stage is exactly test-rehearsal-<n>/u],
  ] as const) {
    const run = spawnSync(process.execPath, [entry, "teardown", "--stage", stage], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    assert.notEqual(run.status, 0, stage);
    assert.match(run.stderr, refusal, stage);
    assert.doesNotMatch(run.stdout, /Outgoing requests/u, stage);
  }
});

test("the entry refuses any stage that names rehearsal without being exactly one", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const entry = fileURLToPath(new URL("./deploy.ts", import.meta.url));
  for (const [command, stage] of [
    ["deploy", "test-rehearsal-2-x"],
    ["plan", "test-rehearsal-2-x"],
    ["deploy", "test-x-test-rehearsal-2"],
    ["destroy", "test-rehearsal-02"],
    ["deploy", "test-rehearsal-10"],
    ["plan", "test-rehearsal"],
  ] as const) {
    const run = spawnSync(process.execPath, [entry, command, "--stage", stage], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    assert.notEqual(run.status, 0, stage);
    assert.match(run.stderr, /A rehearsal stage is exactly test-rehearsal-<n>/u, stage);
    assert.doesNotMatch(run.stdout, /Outgoing requests/u, stage);
  }
});
