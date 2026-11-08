/** Failed OAuth work must leave existing accounts, selections and private bindings usable. */
export function proveZohoMcpRecovery({
  Effect,
  fixture,
  path,
  prefix,
  account,
  restAccount,
  request,
  response,
  call,
  check,
}) {
  return Effect.gen(function* () {
    const accounts = () =>
      request("GET", `${prefix}/inventory`).pipe(
        Effect.map((inventory) => inventory.accounts.map((saved) => saved.id).sort()),
      );
    const before = yield* accounts();
    const failed = yield* request("POST", `${path}/accounts/user/people/connections`, {});
    const failedPath = `${prefix}/connections/${failed.id}`;
    yield* request("POST", `${failedPath}/mcp-endpoint`, {
      method: "mcp",
      endpoint: fixture.endpoint,
    });
    fixture.failDiscovery(true);
    try {
      check(
        "failed discovery refuses OAuth",
        (yield* response("POST", `${failedPath}/oauth/start`, { method: "mcp" })).status >= 400,
        true,
      );
    } finally {
      fixture.failDiscovery(false);
    }
    check("the discovery failure reached the fixture", fixture.counts.discoveryFailures > 0, true);
    check("failed discovery saves no account", yield* accounts(), before);
    yield* call("timeTracker.listTimeLogs", restAccount, { query: { user: "employee-fixture" } });
    check("REST remains usable after failed MCP discovery", true, true);
    const retry = yield* request("POST", `${failedPath}/oauth/start`, { method: "mcp" });
    const retryCallback = yield* Effect.promise(() => fixture.approve(retry.authorizationUrl));
    const recovered = yield* request("POST", `${failedPath}/oauth/complete`, {
      callbackUrl: retryCallback,
    });
    yield* call("mcp.readPeople", recovered);
    check("the failed discovery connection can retry successfully", recovered.method, "mcp");

    const reconnect = () =>
      request("POST", `${path}/accounts/user/people/connections`, { account: account.id });
    const proveKept = (name) =>
      Effect.gen(function* () {
        const linked = yield* request("GET", `${path}/accounts/user`);
        check(
          name + " keeps the selected account",
          linked.some((link) => link.account.id === account.id),
          true,
        );
        const beforeCalls = fixture.calls.length;
        yield* call("mcp.readPeople", account);
        check(
          name + " keeps its exact endpoint and usable grant",
          fixture.calls.length,
          beforeCalls + 1,
        );
      });
    const cancelled = yield* reconnect();
    const cancelPath = `${prefix}/connections/${cancelled.id}`;
    const started = yield* request("POST", `${cancelPath}/oauth/start`, { method: "mcp" });
    check("reconnect uses its saved private binding", typeof started.authorizationUrl, "string");
    yield* request("POST", `${cancelPath}/cancel`, {});
    yield* proveKept("cancelled reconnect");

    const rejected = yield* reconnect();
    const rejectPath = `${prefix}/connections/${rejected.id}`;
    const attempt = yield* request("POST", `${rejectPath}/oauth/start`, { method: "mcp" });
    const callback = yield* Effect.promise(() => fixture.approve(attempt.authorizationUrl));
    fixture.failToken(true);
    try {
      check(
        "failed reconnect refuses token completion",
        (yield* response("POST", `${rejectPath}/oauth/complete`, { callbackUrl: callback }))
          .status >= 400,
        true,
      );
    } finally {
      fixture.failToken(false);
    }
    check(
      "the reconnect token failure reached the fixture",
      fixture.counts.tokenFailures > 0,
      true,
    );
    yield* proveKept("failed reconnect");
    const rejectedState = yield* request("GET", rejectPath);
    if (rejectedState.state.status === "pending")
      yield* request("POST", `${rejectPath}/cancel`, {});
  });
}
