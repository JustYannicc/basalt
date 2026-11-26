import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const upstream = new URL("../../.upstream/", import.meta.url);
// The UI package's own Effect, so atoms and errors share one runtime with the highlight contract.
const require = createRequire(new URL("packages/ui/package.json", upstream));
const { Effect, Exit, Cause } = require("effect") as typeof import("effect");
const { AsyncResult, AtomRegistry } = (await import(
  require.resolve("effect/reactivity")
)) as typeof import("effect/reactivity");

type Token = { readonly content: string; readonly htmlStyle?: Readonly<Record<string, string>> };
type Lines = import("effect/reactivity").AsyncResult.AsyncResult<
  ReadonlyArray<ReadonlyArray<Token>>,
  unknown
>;
const contract = (await import(
  new URL("packages/ui/src/contracts/highlight.ts", upstream).href
)) as {
  readonly highlightedAtom: (input: {
    readonly code: string;
    readonly language: string;
  }) => import("effect/reactivity").Atom.Atom<Lines>;
};

test("code views outside the dashboard's server build still highlight with both themes", async () => {
  const registry = AtomRegistry.make();
  const atom = contract.highlightedAtom({ code: "const a = 1;", language: "typescript" });
  const lines = await new Promise<ReadonlyArray<ReadonlyArray<Token>>>((resolve, reject) => {
    const settle = (result: Lines) => {
      if (AsyncResult.isSuccess(result)) resolve(result.value);
      else if (AsyncResult.isFailure(result)) reject(new Error(Cause.pretty(result.cause)));
    };
    registry.subscribe(atom, settle, { immediate: true });
  });
  registry.dispose();
  const keyword = lines[0]?.find((token) => token.content.trim() === "const");
  assert.ok(keyword?.htmlStyle?.color, "the keyword must carry its light color");
  assert.ok(keyword.htmlStyle["--shiki-dark"], "and its dark color");
  assert.equal(lines[0]?.map((token) => token.content).join(""), "const a = 1;");
});

test("the dashboard's server highlight engine fails as unavailable instead of highlighting", async () => {
  const { highlighter } = (await import(
    new URL("apps/hosted/cloud/web/server-highlight-engine.ts", upstream).href
  )) as { readonly highlighter: import("effect").Effect.Effect<unknown, { _tag: string }> };
  const exit = await Effect.runPromiseExit(highlighter);
  assert.ok(Exit.isFailure(exit), "the server engine must never highlight");
  // A failure, as the real engine reports one, so code views render their plain text.
  assert.ok(!Cause.hasDies(exit.cause));
  assert.match(Cause.pretty(exit.cause), /HighlightUnavailable/);
});
