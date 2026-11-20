import { describe, expect, it } from "vitest";
import { managedReference } from "./rehearsal-native-hooks.ts";

const account = "0".repeat(32);
const digest = `sha256:${"a".repeat(64)}`;

describe("managedReference", () => {
  it("keeps a digest reference as it is", () => {
    const reference = `registry.cloudflare.com/${account}/basalt-poolcontainer-x@${digest}`;
    expect(managedReference(reference)).toEqual({ kind: "digest", reference });
  });

  it("splits a tagged reference into repository and tag", () => {
    expect(
      managedReference(`registry.cloudflare.com/${account}/basalt-rehearsal-poolcontainer:abc123`),
    ).toEqual({
      kind: "tag",
      repository: `${account}/basalt-rehearsal-poolcontainer`,
      tag: "abc123",
    });
  });

  it("refuses anything outside the managed registry or a short digest", () => {
    expect(() => managedReference(`docker.io/library/alpine@${digest}`)).toThrow(/tag or digest/u);
    expect(() =>
      managedReference(`registry.cloudflare.com/${account}/repo@sha256:${"a".repeat(12)}`),
    ).toThrow(/tag or digest/u);
  });
});
