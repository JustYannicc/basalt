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
const watching = ["apps", "session"];
const gaveUp = {
  behind: [],
  unavailable: [{ reason: "unavailable", watching }],
  undecodable: [{ reason: "unavailable", watching }],
  revoked: [],
  identity: [],
  late: [{ reason: "unavailable", watching }],
  ended: [{ reason: "ended", watching }],
} as const;
/** How many head reads each case makes: one per attempt before and after its body. */
const headReads = { behind: 6, unavailable: 1, undecodable: 1, revoked: 1, identity: 2, late: 6 };
const titles = {
  behind:
    "a server read whose heads move under every attempt renders the viewer's own write, with the heads read before it",
  identity: "a server read whose identity changes between its heads reads is refused",
  late: "a server read whose heads stop answering after they moved is refused",
  ended: "a server read still in flight when the request ends says so",
} as const;

for (const reason of [
  "behind",
  "unavailable",
  "undecodable",
  "revoked",
  "identity",
  "late",
  "ended",
] as const)
  test(
    reason in titles
      ? titles[reason as keyof typeof titles]
      : `a server ${reason} fence failure hydrates as the same body-free failure`,
    { timeout: 5000 },
    async (t) => {
      const previousWindow = globals.window;
      const previousDocument = globals.document;
      const previousFetch = globalThis.fetch;
      globalThis.fetch = () => new Promise<Response>(() => {});
      delete globals.window;
      // The viewer's own write committed before the page was requested: the heads already count it.
      const store = { links: "the viewer's own link", head: 1 };
      let calls = 0;
      /** The current heads. Another writer commits after every head read, so each one moves. */
      const heads = (identity = "fixture-viewer") => {
        const response = new Response(
          JSON.stringify({
            identity,
            revisions: [{ topic: "apps", resource: "*", revision: String(store.head) }],
          }),
          { status: 200 },
        );
        store.head++;
        return response;
      };
      const fetch = () => {
        calls++;
        // A read the document never hears back from.
        if (reason === "ended") return new Promise<Response>(() => {});
        // Heads that answer but cannot be read.
        if (reason === "undecodable") return Promise.resolve(new Response("{}", { status: 200 }));
        if (reason === "behind") return Promise.resolve(heads());
        if (reason === "identity")
          return Promise.resolve(heads(calls === 1 ? "fixture-viewer" : "another-viewer"));
        // Two attempts see the heads move; the third attempt's second head read fails.
        if (reason === "late")
          return Promise.resolve(calls < 6 ? heads() : new Response(null, { status: 503 }));
        return Promise.resolve(new Response(null, { status: reason === "revoked" ? 403 : 503 }));
      };
      const source = Atom.readable(() =>
        AsyncResult.success(
          reason === "behind" ? JSON.stringify(store) : "unconfirmed fixture body",
        ),
      ).pipe(
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
      const lines = (line: string) =>
        warnings.mock.calls
          .map((call) => call.arguments)
          .filter(([message]) => message === line)
          .map(([, detail]) => detail);
      const logged = () => lines("Dashboard committed read gave up");
      if (reason === "ended") {
        // A request mounts its reads until it ends, as the document's registry does.
        server.mount(query);
        server.get(query);
        assert.deepEqual(logged(), [], "nothing is said while the read is in flight");
        // The request ends while its read waits: the document has rendered it as loading.
        server.dispose();
        assert.deepEqual(logged(), gaveUp.ended);
        return;
      }
      const settled = await new Promise<unknown>((resolve) => {
        server.subscribe(query, (value: { readonly waiting: boolean }) => {
          if (AsyncResult.isFailure(value) || (AsyncResult.isSuccess(value) && !value.waiting))
            resolve(value);
        });
        server.get(query);
      });
      assert.equal(calls, headReads[reason], "the server fence used its request-bound fetch");
      const tag = (value: unknown) => {
        assert.ok(typeof value === "object" && value !== null && "_tag" in value);
        if (value._tag !== "Failure") return value._tag;
        assert.ok("cause" in value);
        const error = Option.getOrThrow(Cause.findErrorOption(value.cause));
        assert.ok(typeof error === "object" && error !== null && "_tag" in error);
        return error._tag;
      };
      const expected =
        reason === "behind"
          ? "Success"
          : reason === "revoked" || reason === "identity"
            ? "OrganizationForbidden"
            : "ChangeRefreshFailed";
      assert.equal(tag(settled), expected);
      assert.deepEqual(logged(), gaveUp[reason], "the server names why its read gave up");
      assert.deepEqual(
        lines("Dashboard committed read rendered behind"),
        reason === "behind" ? [{ topics: ["apps"], watching }] : [],
        "a read rendered behind moving heads names the topics that moved",
      );
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
      if (reason === "behind") {
        const accepted = document.find(({ key }) => key.startsWith("hosted:accepted:"));
        assert.ok(accepted !== undefined, "the document carries the accepted read");
        const value = accepted.value as {
          body: { value: string };
          receipt: { revisions: readonly { topic: string; revision: string }[] };
        };
        const read = JSON.parse(value.body.value) as { links: string; head: number };
        assert.equal(read.links, "the viewer's own link", "the viewer's write shows");
        // Head reads 1 to 6 saw revisions 1 to 6; the last attempt read its body after revision 5.
        assert.deepEqual(
          value.receipt.revisions.map(({ topic, revision }) => [topic, revision]),
          [["apps", "5"]],
          "the body goes out with the heads read before it, so the browser sees it is behind",
        );
        assert.equal(read.head, 6, "the body was read after those heads, never before them");
      } else assert.ok(!JSON.stringify(document).includes("unconfirmed fixture body"));
      server.dispose();
      assert.deepEqual(
        logged(),
        gaveUp[reason],
        "a settled read says nothing when the request ends",
      );
      Hydration.hydrate(browser, document);
      globals.window = { addEventListener() {}, removeEventListener() {} };
      globals.document = {
        visibilityState: "visible",
        addEventListener() {},
        removeEventListener() {},
      };
      const hydrated = browser.get(query);
      assert.equal(tag(hydrated), expected, "the first browser render matches the server's");
      assert.equal(hydrated.waiting, (settled as { waiting: boolean }).waiting);
      browser.dispose();
      assert.deepEqual(logged(), gaveUp[reason], "the browser says nothing of its own reads");
    },
  );
