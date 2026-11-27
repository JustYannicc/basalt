import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) =>
  readFileSync(new URL(`../containers/pool/${path}`, import.meta.url), "utf8");

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const editedFiles = (patch: string) =>
  patch
    .split("\n")
    .flatMap((line) => /^diff --git a\/\S+ b\/(\S+)$/.exec(line)?.slice(1) ?? [])
    .sort();

test("the node context adaptation preserves the original submission code and regression assertions", () => {
  const original = read("retired/0611-node-generation-submission.patch");
  const adapted = read("retired/0642-node-generation-submission.patch");
  assert.equal(
    sha256(original),
    "10d0e78169a3fdd262e77742963b830c49fc3b60c2424d4a3692079938c309b0",
  );
  const edits = (patch: string) =>
    patch.split("\n").filter((line) => line.startsWith("diff --git ") || /^[+-]/.test(line));
  assert.deepEqual(edits(adapted), edits(original));
});

for (const [originalName, adaptedName, originalSha256, reindent] of [
  [
    "0507-node-usage-credit-routing",
    "0647-node-usage-credit-routing",
    "4c5935844c7130f55a230fa134423a73cbc30c8edd0ca07992dea611f9ed94dc",
    true,
  ],
  [
    "0592-node-terminal-request-id",
    "0648-node-terminal-request-id",
    "1212239730812b277f6cc5007024e9f2f24c68910eb6f0e92c84db735bfce42b",
    false,
  ],
] as const) {
  test(`${adaptedName} preserves the immutable original and all code edits`, () => {
    const original = read(`retired/${originalName}.patch`);
    const adapted = read(`patches/${adaptedName}.patch`);
    assert.equal(sha256(original), originalSha256);
    const edits = (patch: string, removeExtraIndent = false) => {
      let retryHandler = false;
      return patch
        .split("\n")
        .filter((line) => line.startsWith("diff --git ") || /^[+-]/.test(line))
        .map((line) => {
          if (line.startsWith("diff --git ")) {
            retryHandler = line.endsWith(
              " b/sdk/api/handlers/openai/openai_responses_websocket.go",
            );
          }
          if (
            removeExtraIndent &&
            retryHandler &&
            /^[+-].+/.test(line) &&
            !/^(---|\+\+\+)/.test(line)
          ) {
            assert.match(line, /^[+-]\t/);
            return line.replace(/^([+-])\t/, "$1");
          }
          return line;
        });
    };
    assert.deepEqual(edits(adapted, reindent), edits(original));
  });
}

// Where upstream rewrote a carry's paths, the adapted carry keeps the original's
// scope rather than its exact lines. A file leaves a carry only when the pinned
// source now does that carry's work, and enters one only when a re-cut lists it
// here with its reason. A listed file the carry no longer edits is a scope change
// too, so the list can never go stale silently.
const scopeDrift = (
  adaptedFiles: readonly string[],
  originalFiles: readonly string[],
  coveredUpstream: readonly string[],
  addedAtRecut: readonly string[],
) => {
  const covered = new Set(coveredUpstream);
  const expected = new Set([
    ...originalFiles.filter((file) => !covered.has(file)),
    ...addedAtRecut,
  ]);
  const actual = new Set(adaptedFiles);
  return {
    unexpected: [...actual].filter((file) => !expected.has(file)).sort(),
    missing: [...expected].filter((file) => !actual.has(file)).sort(),
    listedButOriginal: addedAtRecut.filter((file) => originalFiles.includes(file)).sort(),
  };
};

test("the scope check refuses an unlisted file and a listed file the carry no longer edits", () => {
  const original = ["a.go", "b.go"];
  assert.deepEqual(scopeDrift(["a.go", "c.go", "d.go"], original, ["b.go"], ["c.go"]), {
    unexpected: ["d.go"],
    missing: [],
    listedButOriginal: [],
  });
  assert.deepEqual(scopeDrift(["a.go"], original, ["b.go"], ["c.go"]), {
    unexpected: [],
    missing: ["c.go"],
    listedButOriginal: [],
  });
  assert.deepEqual(scopeDrift(["a.go", "b.go"], original, [], ["b.go"]).listedButOriginal, [
    "b.go",
  ]);
});

for (const [originalName, adaptedName, originalSha256, coveredUpstream, addedAtRecut] of [
  [
    "cliproxy-node-v8.0.51-metadata-only",
    "0646-node-metadata-only",
    "dc68c2f4dde4c0601bdc6bb7cb731e98f2c7098431f380265bb531b280f0ab84",
    [],
    [],
  ],
  [
    "0599-node-no-postwrite-replay",
    "0649-node-no-postwrite-replay",
    "ac31a3fd18d9808402086fd766ca73328ad0c18ad157c00ab61ae28e92997c51",
    [],
    [],
  ],
  [
    "0642-node-generation-submission",
    "0650-node-generation-submission",
    "47255fb46bab0d51825001f5b5f79d136e924fe28b9937740d93f0471423656f",
    // Credits fallback classifies submission through upstream's attempt marking.
    ["sdk/cliproxy/auth/conductor_home.go"],
    [
      // Upstream's Home local plugin dispatch runs outside the conductor; the grant carries the guard.
      "sdk/api/handlers/handlers_execution.go",
      // The same guard on the stream path, chunk errors included.
      "sdk/api/handlers/handlers_stream.go",
      // Upstream's liveness test calls the websocket write whose signature this carry changes.
      "internal/runtime/executor/codex_websockets_liveness_test.go",
      // One named accepted-then-cut case per upstream path that rotates an accepted generation.
      "internal/runtime/executor/basalt_accepted_cut_no_replay_test.go",
      // A granted local plugin is never sent again, and our Home cannot grant one.
      "internal/pluginhost/basalt_local_grant_submission_test.go",
    ],
  ],
] as const) {
  test(`${adaptedName} keeps the immutable original's scope`, () => {
    const original = read(`retired/${originalName}.patch`);
    const adapted = read(`patches/${adaptedName}.patch`);
    assert.equal(sha256(original), originalSha256);
    assert.deepEqual(
      scopeDrift(editedFiles(adapted), editedFiles(original), coveredUpstream, addedAtRecut),
      {
        unexpected: [],
        missing: [],
        listedButOriginal: [],
      },
    );
  });
}
