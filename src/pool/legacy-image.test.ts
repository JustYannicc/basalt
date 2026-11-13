import assert from "node:assert/strict";
import { test } from "node:test";
import { retainedLegacyImage } from "./legacy-image.ts";

const attributes = {
  accountId: "synthetic-account",
  applicationId: "synthetic-app",
  configuration: {
    image: `registry.cloudflare.com/synthetic-account/pool@sha256:${"a".repeat(64)}`,
  },
  hash: { image: "b".repeat(16), digest: `sha256:${"a".repeat(64)}` },
};
const state = {
  status: "updated",
  resourceType: "Cloudflare.Container",
  logicalId: "PoolContainer",
  attr: attributes,
};

test("legacy deployment keeps the immutable reference and original runtime input from settled state", () => {
  assert.equal(retainedLegacyImage(undefined), undefined);
  assert.deepEqual(retainedLegacyImage(state), {
    image: attributes.configuration.image,
    inputHash: attributes.hash.image,
    digest: attributes.hash.digest,
    applicationId: attributes.applicationId,
  });
  assert.deepEqual(
    retainedLegacyImage({
      ...state,
      status: "updating",
      old: { attr: attributes },
      attr: { ...attributes, hash: { ...attributes.hash, image: "c".repeat(16) } },
    }),
    retainedLegacyImage(state),
  );
});

test("an unsettled, mutable, foreign-registry or hashless baseline cannot silently rebuild legacy", () => {
  for (const changed of [
    { ...state, status: "creating" },
    { ...state, status: "updating" },
    { ...state, logicalId: "OtherContainer" },
    { ...state, attr: { ...attributes, hash: {} } },
    {
      ...state,
      attr: {
        ...attributes,
        configuration: { image: "registry.cloudflare.com/synthetic-account/pool:latest" },
      },
    },
    {
      ...state,
      attr: {
        ...attributes,
        configuration: { image: `registry.cloudflare.com/other/pool@${attributes.hash.digest}` },
      },
    },
  ])
    assert.throws(
      () => retainedLegacyImage(changed),
      /Retained pool image is unavailable or unsettled/,
    );
});
