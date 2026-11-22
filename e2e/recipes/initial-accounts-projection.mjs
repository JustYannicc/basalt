import assert from "node:assert/strict";

/** Hold initial projections before transport, where a request-idle check cannot see them. */
export async function holdInitialAccountsProjection(context, installReadRouting) {
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const released = new Promise((resolve) => {
    release = resolve;
  });
  const binding = "__basaltInitialAccountsProjection";
  await context.exposeFunction(binding, async () => {
    enter();
    await released;
  });
  const installHold = ({ binding }) => {
    const native = window.fetch;
    let holding = true;
    const delayed = (input, init) => {
      const url = URL.parse(input instanceof Request ? input.url : String(input), location.href);
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      const accounts =
        url?.origin === location.origin &&
        method === "GET" &&
        /^\/api\/organizations\/[^/]+\/resources\/accounts$/.test(url.pathname);
      if (holding && accounts) {
        // Another initial read can satisfy the response join before the first one is released.
        return window[binding]().then(() => {
          holding = false;
          return native(input, init);
        });
      }
      return native(input, init);
    };
    Object.defineProperty(delayed, "toString", {
      value: () => Function.prototype.toString.call(native),
    });
    window.fetch = delayed;
  };
  const originalAddInitScript = context.addInitScript;
  const addInitScript = originalAddInitScript.bind(context);
  // One initializer fixes ordering: split reads capture this fetch, and siblings stay unheld.
  context.addInitScript = (script, arg) => {
    assert.equal(typeof script, "function");
    return addInitScript({
      content: `(${installHold})(${JSON.stringify({ binding })});\n(${script})(${JSON.stringify(arg)});`,
    });
  };
  try {
    await installReadRouting();
  } finally {
    context.addInitScript = originalAddInitScript;
  }

  let joinedWhileHeld;
  return {
    release,
    async verifyJoin(page, join, fallbackRow, updating) {
      let joined = false;
      const work = join().then(() => {
        joined = true;
      });
      try {
        // Exercise the same virtual interval while the initial read is still outside transport.
        await page.clock.runFor(6_100);
        await entered;
        assert.equal(await fallbackRow.isVisible(), true, "the directory fallback row is visible");
        assert.equal(await updating.isVisible(), false, "initial projection has no Updating badge");
        joinedWhileHeld = joined;
      } finally {
        release();
        await work;
      }
    },
    assertJoined() {
      assert.equal(
        joinedWhileHeld,
        false,
        "Accounts readiness waits for the held initial projection before measuring idle reads",
      );
    },
  };
}
