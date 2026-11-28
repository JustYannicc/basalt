import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { Atom, AtomRegistry, AsyncResult, Hydration } = await import(
  require.resolve("effect/reactivity")
);
const { Schema, Cause, Option } = await import(require.resolve("effect"));
const { changeProtected } =
  await import("../../.upstream/apps/hosted/web/src/contracts/change-signal.ts");
const { apiFetchAtom } =
  await import("../../.upstream/packages/dashboard-start/src/contracts/api.ts");

const { OrganizationSlug } =
  await import("../../.upstream/apps/hosted/server/src/contracts/organization.ts");
const organization = Schema.decodeUnknownSync(OrganizationSlug)("fixture-organization");

const globals = globalThis as { window?: unknown; document?: unknown };

/** What the server says when its read gives up: one line with a closed reason, per case. */
const gaveUp = {
  moving: [{ reason: "moved", topics: ["apps"] }],
  unavailable: [{ reason: "unavailable" }],
  revoked: [],
  deadline: [{ reason: "deadline" }],
} as const;

for (const reason of ["moving", "unavailable", "revoked", "deadline"] as const)
  test(
    reason === "deadline"
      ? "a server read the document finished without says it ran past the render"
      : `a server ${reason} fence failure hydrates as the same body-free failure`,
    { timeout: 5000 },
    async (t) => {
      const previousWindow = globals.window;
      const previousDocument = globals.document;
      const previousFetch = globalThis.fetch;
      globalThis.fetch = () => new Promise<Response>(() => {});
      delete globals.window;
      let revision = 0;
      let calls = 0;
      const fetch = () => {
        calls++;
        // A read the document never hears back from.
        if (reason === "deadline") return new Promise<Response>(() => {});
        return Promise.resolve(
          reason === "moving"
            ? new Response(
                JSON.stringify({
                  identity: "fixture-viewer",
                  revisions: [{ topic: "apps", resource: "*", revision: String(++revision) }],
                }),
                { status: 200 },
              )
            : new Response(null, { status: reason === "revoked" ? 403 : 503 }),
        );
      };
      const source = Atom.readable(() => AsyncResult.success("unconfirmed fixture body")).pipe(
        Atom.serializable({
          key: `fixture-read:${reason}`,
          schema: AsyncResult.Schema({ success: Schema.String }),
        }),
      );
      const query = changeProtected(organization, ["apps"])(source);
      t.mock.method(apiFetchAtom, "read", () => fetch);
      const server = AtomRegistry.make();
      const browser = AtomRegistry.make();
      t.after(() => {
        server.dispose();
        browser.dispose();
        if (previousWindow === undefined) delete globals.window;
        else globals.window = previousWindow;
        if (previousDocument === undefined) delete globals.document;
        else globals.document = previousDocument;
        globalThis.fetch = previousFetch;
      });
      const warnings = t.mock.method(console, "warn");
      const logged = () =>
        warnings.mock.calls
          .map((call) => call.arguments)
          .filter(([message]) => message === "Dashboard committed read gave up")
          .map(([, detail]) => detail);
      if (reason === "deadline") {
        const stop = server.subscribe(query, () => {});
        server.get(query);
        assert.deepEqual(logged(), [], "nothing is said while the read is in flight");
        // The request ends while its read waits: the document has rendered it as loading.
        stop();
        server.dispose();
        assert.deepEqual(logged(), gaveUp.deadline);
        return;
      }
      const failure = await new Promise<unknown>((resolve) => {
        server.subscribe(query, (value: unknown) => {
          if (AsyncResult.isFailure(value)) resolve(value);
        });
        server.get(query);
      });
      const expected = reason === "revoked" ? "OrganizationForbidden" : "ChangeRefreshFailed";
      assert.equal(
        calls,
        reason === "moving" ? 6 : 1,
        "the server fence used its request-bound fetch",
      );
      const tag = (value: unknown) => {
        assert.ok(typeof value === "object" && value !== null && "_tag" in value);
        if (value._tag !== "Failure") return "Initial";
        assert.ok("cause" in value);
        const error = Option.getOrThrow(Cause.findErrorOption(value.cause));
        assert.ok(typeof error === "object" && error !== null && "_tag" in error);
        return error._tag;
      };
      assert.equal(tag(failure), expected);
      assert.deepEqual(logged(), gaveUp[reason], "the server names why its read gave up");
      const document = [...server.getNodes()].flatMap(([key, node]) => {
        if (typeof key !== "string" || !Atom.isSerializable(node.atom)) return [];
        try {
          return [
            {
              "~effect/reactivity/Hydration/DehydratedAtom": true,
              key,
              value: node.atom[Atom.SerializableTypeId].encode(node.value()),
              dehydratedAt: Date.now(),
            },
          ];
        } catch {
          return [];
        }
      });
      assert.ok(!JSON.stringify(document).includes("unconfirmed fixture body"));
      Hydration.hydrate(browser, document);
      globals.window = { addEventListener() {}, removeEventListener() {} };
      globals.document = {
        visibilityState: "visible",
        addEventListener() {},
        removeEventListener() {},
      };
      const hydrated = browser.get(query);
      assert.equal(tag(hydrated), expected, "the first browser render matches the server error");
      assert.equal(hydrated.waiting, (failure as { waiting: boolean }).waiting);
    },
  );
