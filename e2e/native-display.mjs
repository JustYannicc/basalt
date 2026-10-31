import assert from "node:assert/strict";

/** The CLI's public requests traverse the real Router and hosted native-grant endpoint. */
export async function verifyNativeDisplay({ worker, origin, headers, owner, poolId, setDisplay }) {
  const response = await fetch(
    `${worker.origin}/api/auth/get-session?disableCookieCache=true&disableRefresh=true`,
    { headers: owner },
  );
  assert.equal(response.status, 200);
  const { user } = await response.json();
  const expected = {
    account: {
      name: user.name?.trim() || user.email,
      email: user.email,
      emailVerified: user.emailVerified,
    },
    pool: { id: poolId, name: "Native protocol pool" },
    pools: [
      { id: poolId, name: "Native protocol pool" },
      { id: "shared-native-pool", name: "Shared native pool" },
    ],
  };
  assert.deepEqual(worker.display(), expected);
  const browserOnly = await fetch(`${worker.origin}/api/auth/native/access`, { headers: owner });
  assert.equal(browserOnly.status, 401, "A browser session does not replace the native bearer.");
  await browserOnly.body?.cancel();
  try {
    await setDisplay(false);
    const retained = await fetch(`${origin}/v1/models`, { headers });
    assert.equal(
      retained.status,
      200,
      "A retained pool Worker still authorizes the existing client.",
    );
    await retained.body?.cancel();
    assert.equal(worker.display(), undefined);
  } finally {
    await setDisplay(true);
  }
  const current = await fetch(`${origin}/v1/models`, { headers });
  assert.equal(current.status, 200);
  await current.body?.cancel();
  assert.deepEqual(worker.display(), expected);
}
