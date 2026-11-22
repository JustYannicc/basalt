import assert from "node:assert/strict";
import { test } from "node:test";
import { autumnEmulatorBuild, autumnEmulatorPin } from "./ci/autumn-emulator.ts";

test("the Autumn emulator builds from one full commit of its repository, checksum-pinned", () => {
  const pin = autumnEmulatorPin();
  assert.match(pin.commit, /^[0-9a-f]{40}$/);
  assert.equal(
    pin.archive.url,
    `https://codeload.github.com/${pin.repository}/tar.gz/${pin.commit}`,
  );
  assert.match(pin.archive.integrity, /^sha(?:256|512)-[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(pin.pnpm.url, `https://registry.npmjs.org/pnpm/-/pnpm-${pin.pnpm.version}.tgz`);
  assert.match(pin.pnpm.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
});

test("a cached build is restored only for the commit, package manager, platform and Node it was built with", () => {
  const pin = autumnEmulatorPin();
  const build = autumnEmulatorBuild("/runner", pin, "linux-x64", "24");
  for (const part of [pin.commit, `pnpm${pin.pnpm.version}`, "linux-x64", "node24"])
    assert.ok(build.key.includes(part), part);
  const moved = autumnEmulatorBuild(
    "/runner",
    { ...pin, commit: "f".repeat(40) },
    "linux-x64",
    "24",
  );
  assert.notEqual(moved.key, build.key);
  assert.notEqual(moved.directory, build.directory);
  assert.notEqual(autumnEmulatorBuild("/runner", pin, "linux-arm64", "24").key, build.key);
  assert.notEqual(autumnEmulatorBuild("/runner", pin, "linux-x64", "26").key, build.key);
});
