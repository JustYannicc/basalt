import { describe, expect, it } from "vitest";
import {
  adoptScope,
  adoptTarget,
  adoptedState,
  requiredPin,
  rootMatchesPin,
  settledProof,
} from "./stage-adopt.ts";

const image = `registry.cloudflare.com/${"0".repeat(32)}/basalt-poolcontainer@sha256:${"e".repeat(64)}`;
const pin = { image, input: "526fa60bed0df442" };

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

describe("requiredPin", () => {
  it("refuses to adopt without the pinned image and input", () => {
    expect(() => requiredPin({})).toThrow(/pinned image/u);
    expect(() => requiredPin({ STAGE_ADOPT_EXPECTED_INPUT: pin.input })).toThrow(/pinned image/u);
    expect(() =>
      requiredPin({
        STAGE_ADOPT_EXPECTED_IMAGE: image.replace(/@.*/u, ":latest"),
        STAGE_ADOPT_EXPECTED_INPUT: pin.input,
      }),
    ).toThrow(/pinned image/u);
    expect(
      requiredPin({ STAGE_ADOPT_EXPECTED_IMAGE: image, STAGE_ADOPT_EXPECTED_INPUT: pin.input }),
    ).toEqual(pin);
  });
});

describe("rootMatchesPin", () => {
  it("accepts only the pinned image and input", () => {
    expect(() => rootMatchesPin({ image, input: pin.input }, pin)).not.toThrow();
  });

  it("refuses a root whose digest differs, even with the right input", () => {
    expect(() =>
      rootMatchesPin({ image: image.replace(/e{64}$/u, "f".repeat(64)), input: pin.input }, pin),
    ).toThrow(/pinned digest/u);
    expect(() => rootMatchesPin({ image: undefined, input: pin.input }, pin)).toThrow(
      /pinned digest/u,
    );
  });

  it("refuses a root whose input differs", () => {
    expect(() => rootMatchesPin({ image, input: "0".repeat(16) }, pin)).toThrow(/image input/u);
  });
});

describe("settledProof", () => {
  const read = (digest: string, revision: number) => ({
    digest,
    policies: [
      { pool: "app_b", revision: 1 },
      { pool: "app_a", revision },
    ],
  });

  it("returns the proof when two reads agree, in any policy order", () => {
    expect(
      settledProof(read("d1", 2), {
        ...read("d1", 2),
        policies: [...read("d1", 2).policies].reverse(),
      }),
    ).toEqual({
      digest: "d1",
      revisions: [
        ["app_a", 2],
        ["app_b", 1],
      ],
    });
  });

  it("refuses while the digest or a revision moves", () => {
    expect(() => settledProof(read("d1", 2), read("d2", 2))).toThrow(/still changing/u);
    expect(() => settledProof(read("d1", 2), read("d1", 3))).toThrow(/still changing/u);
  });
});
