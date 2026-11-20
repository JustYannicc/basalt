import { describe, expect, it } from "vitest";
import { adoptScope, adoptTarget, adoptedState } from "./stage-adopt.ts";

describe("adoptTarget", () => {
  it("accepts a standing rehearsal stage and its own pool Worker", () => {
    expect(adoptTarget("test-rehearsal-2")).toBe("test-rehearsal-2");
    expect(
      adoptTarget("test-rehearsal-2", "basalt-rehearsal-poolworker-test-rehearsal-2-abc"),
    ).toBe("test-rehearsal-2");
  });

  it("refuses production, previews and an unset stage", () => {
    for (const stage of ["production", "test-preview-1", "test-rehearsal-0", "", undefined])
      expect(() => adoptTarget(stage)).toThrow(/test-rehearsal/u);
  });

  it("refuses a production pool Worker address even on a rehearsal stage", () => {
    expect(() => adoptTarget("test-rehearsal-2", "basalt-poolworker-production-abc")).toThrow(
      /not this stage's/u,
    );
    expect(() =>
      adoptTarget("test-rehearsal-2", "basalt-rehearsal-poolworker-test-rehearsal-21-abc"),
    ).toThrow(/not this stage's/u);
  });
});

describe("adoptedState", () => {
  it("reads production's adopted shape", () => {
    expect(
      adoptedState(
        {
          selection: {
            epoch: 1,
            active: {
              fenced: false,
              target: {
                slotId: "legacy",
                applicationVersion: 3,
                imageDigest: "sha256:e",
                imageInput: "526fa60bed0df442",
              },
            },
          },
        },
        true,
      ),
    ).toEqual({
      epoch: 1,
      slotId: "legacy",
      homePeerOrdinal: false,
      fenced: false,
      applicationVersion: 3,
      imageDigest: "sha256:e",
      imageInput: "526fa60bed0df442",
      healthy: true,
    });
  });

  it("reads no selection as nulls", () => {
    expect(adoptedState({ selection: null }, false)).toMatchObject({
      epoch: null,
      slotId: null,
      fenced: null,
      healthy: false,
    });
  });
});

describe("adoptScope", () => {
  it("names the rehearsal stack and the stage it adopts on", async () => {
    expect(await adoptScope({ ALCHEMY_STAGE: "test-rehearsal-2" })).toEqual({
      stack: "basalt-rehearsal",
      stage: "test-rehearsal-2",
    });
  });

  it("refuses production, named or unset", async () => {
    await expect(adoptScope({ ALCHEMY_STAGE: "production" })).rejects.toThrow(/production/u);
    await expect(adoptScope({})).rejects.toThrow(/production/u);
  });
});
