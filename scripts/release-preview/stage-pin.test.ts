import { describe, expect, it } from "vitest";
import { managedReference } from "./rehearsal-native-hooks.ts";
import { composeRootPin } from "./stage-pin.ts";

const account = "0".repeat(32);
const parts = (patch: Record<string, string> = {}) =>
  JSON.stringify({
    repository: "basalt-poolcontainer-production-abc",
    digest: `sha256:${"e".repeat(64)}`,
    input: "526fa60bed0df442",
    ...patch,
  });

describe("composeRootPin", () => {
  it("is absent when the lane has no root image", () => {
    expect(composeRootPin(undefined, account)).toBeUndefined();
    expect(composeRootPin("  ", account)).toBeUndefined();
  });

  it("composes a digest reference the fleet pin keeps as it is", () => {
    const pin = JSON.parse(composeRootPin(parts(), account)!) as { image: string; input: string };
    expect(pin.input).toBe("526fa60bed0df442");
    expect(managedReference(pin.image)).toEqual({ kind: "digest", reference: pin.image });
  });

  it("refuses a short digest, a bad input, a tag, or a missing account", () => {
    expect(() => composeRootPin(parts({ digest: "sha256:ed541640" }), account)).toThrow();
    expect(() => composeRootPin(parts({ input: "526fa60b" }), account)).toThrow();
    expect(() => composeRootPin(parts({ repository: "repo:latest" }), account)).toThrow();
    expect(() => composeRootPin(parts(), undefined)).toThrow(/account id/u);
    expect(() => composeRootPin("not json", account)).toThrow();
  });
});
