import assert from "node:assert/strict";
import { test } from "node:test";
import { checkManifest, limits } from "./manifest.mjs";

const version = "0.0.1-beta.104-basalt.1";
const file = (path, content = "") => ({ path, bytes: Buffer.from(content) });
const base = () => [
  file("index.ts"),
  file("package.json", JSON.stringify({ type: "module", dependencies: { apps: version } })),
];
const errors = (extra) => checkManifest([...base(), ...extra], version);

test("manifest checks exact host pin, module mode and required entry", () => {
  assert.deepEqual(errors([]), []);
  for (const apps of ["latest", "^0.0.1-beta.104", "0.0.1-beta.103", undefined]) {
    const files = [
      file("index.ts"),
      file("package.json", JSON.stringify({ type: "module", dependencies: { apps } })),
    ];
    assert.match(checkManifest(files, version).join("\n"), /framework-pin:/);
  }
  assert.match(
    checkManifest([file("index.ts"), file("package.json", "{}")], version).join("\n"),
    /manifest-module:/,
  );
  assert.match(checkManifest(base().slice(1), version).join("\n"), /missing index.ts/);
});

test("code limits include manifest and accept the exact count and byte boundaries", () => {
  const files = base();
  files.push(...Array.from({ length: limits.sourceFiles - 2 }, (_, i) => file(`source/${i}.txt`)));
  assert.deepEqual(checkManifest(files, version), []);
  assert.match(
    checkManifest([...files, file("extra.txt")], version).join("\n"),
    /source-file-count:/,
  );
  const available = limits.sourceBytes - base().reduce((sum, file) => sum + file.bytes.length, 0);
  const bytes = Buffer.alloc(available, 65);
  assert.deepEqual(errors([{ path: "big.txt", bytes }]), []);
  assert.match(
    errors([{ path: "big.txt", bytes }, file("one-more.txt", "x")]).join("\n"),
    /source-size:/,
  );
});

test("public assets have their own count, individual and total limits", () => {
  const files = Array.from({ length: limits.publicFiles }, (_, i) => file(`ui/public/${i}.bin`));
  assert.deepEqual(errors(files), []);
  assert.match(errors([...files, file("ui/public/extra.bin")]).join("\n"), /public-file-count:/);
  const bytes = Buffer.alloc(limits.publicFileBytes);
  assert.deepEqual(errors([{ path: "ui/public/image.bin", bytes }]), []);
  assert.match(
    errors([{ path: "ui/public/image.bin", bytes: Buffer.alloc(limits.publicFileBytes + 1) }]).join(
      "\n",
    ),
    /public-file-size:/,
  );
  const gigabyte = Array.from({ length: 31 }, (_, i) => ({ path: `ui/public/${i}.bin`, bytes }));
  gigabyte.push({
    path: "ui/public/remainder.bin",
    bytes: Buffer.alloc(limits.publicBytes - 31 * limits.publicFileBytes),
  });
  assert.deepEqual(errors(gigabyte), []);
  assert.match(
    errors([...gigabyte, file("ui/public/extra.bin", "x")]).join("\n"),
    /public-total-size:/,
  );
});

test("unsafe paths, duplicate files and non-text code fail before lint materialization", () => {
  for (const path of [
    "../escape.ts",
    "/escape.ts",
    "foo/../escape.ts",
    "foo\\escape.ts",
    "./index.ts",
    "foo//x",
  ])
    assert.match(errors([file(path)]).join("\n"), /source-path:/);
  assert.match(errors([file("index.ts")]).join("\n"), /duplicate/);
  assert.match(errors([file("nested"), file("nested/child.ts")]).join("\n"), /parent/);
  assert.match(errors([{ path: "bad.ts", bytes: Buffer.from([255]) }]).join("\n"), /source-utf8:/);
  assert.match(errors([file("bad.ts", "\0")]).join("\n"), /source-utf8:/);
  assert.deepEqual(errors([{ path: "ui/public/binary.bin", bytes: Buffer.from([255, 0]) }]), []);
});
