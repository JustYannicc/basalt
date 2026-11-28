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
type Lines = ReadonlyArray<ReadonlyArray<Token>>;
/** What an engine or the contract fails with when it cannot highlight. */
type Unavailable = { readonly _tag: "HighlightUnavailable" };
type Highlighter = {
  readonly codeToTokens: (code: string, options: object) => { readonly tokens: Lines };
  readonly getLoadedLanguages: () => ReadonlyArray<string>;
};
const contract = (await import(
  new URL("packages/ui/src/contracts/highlight.ts", upstream).href
)) as {
  readonly highlightedAtom: (input: {
    readonly code: string;
    readonly language: string;
  }) => import("effect/reactivity").Atom.Atom<
    import("effect/reactivity").AsyncResult.AsyncResult<Lines, Unavailable>
  >;
  readonly highlightLines: (
    highlighter: Highlighter,
    code: string,
    language: string,
  ) => import("effect").Effect.Effect<Lines, Unavailable>;
};
const { highlighter: serverEngine } = (await import(
  new URL("packages/ui/src/implementation/server-highlight-engine.ts", upstream).href
)) as {
  readonly highlighter: import("effect").Effect.Effect<
    Highlighter,
    Unavailable,
    import("effect").Scope.Scope
  >;
};

/** One line in each language the dashboard renders, with a keyword the grammar colors. */
const samples = {
  typescript: "const a: number = 1;",
  javascript: "const a = 1;",
  css: "a { color: red; }",
  html: "<a href='x'>x</a>",
  markdown: "# Title",
  json: '{ "a": 1 }',
  shellscript: "echo hello",
} as const;
const colored = (lines: Lines) =>
  lines[0]?.some((token) => token.htmlStyle?.color && token.htmlStyle["--shiki-dark"]) === true;

const { highlighter: browserEngine } = (await import(
  new URL("packages/ui/src/implementation/highlight-engine.ts", upstream).href
)) as { readonly highlighter: typeof serverEngine };

/** Run `language` through an engine: the server's, which the dashboard Worker uploads, by default. */
const onServer = (language: string, code: string, engine = serverEngine) =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.flatMap(engine, (loaded) => contract.highlightLines(loaded, code, language)),
    ),
  );

test("the browser's engine colors every language the dashboard renders with both themes", async () => {
  for (const [language, code] of Object.entries(samples)) {
    const registry = AtomRegistry.make();
    const atom = contract.highlightedAtom({ code, language });
    const lines = await new Promise<Lines>((resolve, reject) => {
      registry.subscribe(
        atom,
        (result) => {
          if (AsyncResult.isSuccess(result)) resolve(result.value);
          else if (AsyncResult.isFailure(result)) reject(new Error(Cause.pretty(result.cause)));
        },
        { immediate: true },
      );
    });
    registry.dispose();
    assert.ok(colored(lines), `${language} must carry its light and dark colors`);
    assert.equal(lines[0]?.map((token) => token.content).join(""), code);
  }
});

test("the server engine colors TypeScript, JSON and shell exactly as the browser does", async () => {
  for (const language of ["typescript", "json", "shellscript"] as const) {
    const exit = await onServer(language, samples[language]);
    assert.ok(Exit.isSuccess(exit), `${language} must highlight on the server`);
    assert.ok(colored(exit.value), `${language} must carry its light and dark colors`);
    // Hydration keeps the server's tokens, and the browser's engine must not repaint them.
    const browser = await onServer(language, samples[language], browserEngine);
    assert.ok(Exit.isSuccess(browser));
    assert.deepEqual(exit.value, browser.value);
  }
  // Plain text needs no grammar, so it still renders as tokens.
  assert.ok(Exit.isSuccess(await onServer("text", "plain words")));
});

test("the server engine renders every other language plain instead of throwing", async () => {
  for (const language of ["javascript", "css", "html", "markdown", "cobol"]) {
    const exit = await onServer(language, samples[language as keyof typeof samples] ?? "x");
    assert.ok(Exit.isFailure(exit), `${language} must not highlight on the server`);
    // A failure the view renders as plain text, never a defect that would break the render.
    assert.ok(!Cause.hasDies(exit.cause), `${language} must not throw`);
    assert.match(Cause.pretty(exit.cause), /HighlightUnavailable/);
  }
});
