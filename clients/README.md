# Headless connection

Run one connection process for local agents that need cloud models and tools. Agents use local credentials; remote keys stay in the connection's credential store. The process forwards model requests and MCP traffic without keeping a model catalog or running agents.

This implementation currently supports explicit direct keys. Renewable native sign-in is separate work; importing keys does not register a device.

Use Node.js 24.18.0 or newer. Desktop credentials use the OS credential store. Headless Linux can explicitly choose a file readable only by its owner; this has weaker protection at rest. A missing OS store never selects file storage automatically.

## Direct credentials

Create separate model and tools keys on their issuing server. The tools key must be tools-only, with the `ext_` prefix. Save this descriptor in a private file with permissions `0600`; omit a service when it is not needed:

```json
{
  "version": 1,
  "mode": "direct",
  "models": { "origin": "https://<server>", "token": "<model-key>" },
  "tools": { "origin": "https://<server>", "path": "/mcp", "token": "ext_<tools-key>" }
}
```

```sh
node clients/cli/main.mjs import-direct <private-file>
node clients/cli/main.mjs agent add coding-agent models tools
node clients/cli/main.mjs run
```

On headless Linux, explicitly add `--storage file` to `import-direct`. `--home <private-directory>` selects a separate profile for every command. The directory must have permissions `0700`; files containing credentials must have `0600`.

`agent add` saves a private local credential file and prints its path. Configure an agent with the connection's printed loopback origin and that local token. Model requests use `/v1`; tools use `/mcp`. Remote credentials never belong in an agent's configuration. Stdio agents run:

```sh
node clients/cli/main.mjs stdio --agent coding-agent
```

The stdio bridge reaches the same connection process over private IPC. Its stdout contains only MCP messages. Each agent can receive `models`, `tools` or both permissions. `agent remove <id>` refuses future requests from its local credential.

`status` shows redacted connection state. `disconnect` interrupts active requests; `reconnect` reads the saved credentials again. `sign-out` interrupts local work and removes the saved remote credentials. Direct keys are revoked on their issuing server. Restarting preserves the local port and agent settings; a second process for the same profile refuses to start.

Interrupted model streams end. Interrupted tool calls can have an unknown outcome and are never replayed automatically.
