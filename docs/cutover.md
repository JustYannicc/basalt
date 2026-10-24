# Move an existing setup to Basalt

This runbook covers imported subscription login files and computer setup. Tool
connections are made fresh by the owner. It never assumes which proxy, provider
or MCP servers a computer already has.

## Before starting

Keep the old setup running. Wait for the deploy owner to report the first live
deployment. Then import the login files and set up each computer as described
below. Before shutdown, the coordinator collects the first release's live evidence:

- Sign-in creates an empty personal pool. Claude, ChatGPT and Grok connect and
  serve requests. Every supported subscription provider appears in Connect.
- A second person accepts a link, chooses the shared pool and uses it without
  seeing credentials. Removing that person stops their next request.
- Owners see usage per member, model and time. Members see only their own usage.
- Both people use local Claude Code and Codex through their chosen pool.
- Each person connects Google and Confluence, finds and calls their tools from
  both clients, and cannot reach the other person's connections.
- Revoking a computer key or disconnecting an account stops the next request.

Record the deployment revision and evidence privately. The owner's computers
must already work on v1, with the imported accounts verified, before the
coordinator sends the explicit **GO shutdown**. That message authorizes changes
to old resources only. Import, setup and v1 verification happen before it.
Missing evidence keeps the old resources running. This document never
authorizes shutdown by itself.

## Import the login files

Run the import once the destination deployment is live, before **GO shutdown**.
Export the current pool's login files using its authenticated, read-only export mechanism through
the operator's approved tools. Do not change the old pool. Keep credentials in
private files outside the checkout, owned by the operator with mode `0600`.
Never paste credentials into chat, command arguments, logs, issues or PRs.

Get the destination pool's existing scoped control token from the deployment
operator's secure channel. Use its owner's identity and a computer key scoped
to that same pool. The importer accepts no backend management key or signing
key. The server verifies the signed pool token and owner on every upload.

Create a private JSON file with this shape. Replace the placeholders privately.
The `path` values resolve relative to that file. Choose each `model` from the
destination's model catalog so the corresponding subscription can serve it.

```json
{
  "origin": "https://<deployment-host>",
  "poolToken": "<scoped-pool-control-token>",
  "owner": "<pool-owner>",
  "apiKey": "<computer-key-for-this-pool>",
  "accounts": [
    { "path": "<exported-login-file>", "model": "<model-from-the-catalog>" }
  ],
  "attempts": 6
}
```

Validate all inputs without sending any requests:

```sh
node scripts/import-pool-accounts.ts --config <private-json-file> --check
```

Then run the same command without `--check`. Run local verification through the
machine's shared heavy-command slot when required by its operating rules.
HTTPS is required except for loopback fixtures. Redirects are refused.

The tool uploads one file at a time through the supported owner-only
`POST /pool/v1/login-files` path. It requires generated text and a successful
usage record for that exact imported account. Pool membership or a successful
request from another account does not count. It uses fresh sessions, with at
most `attempts` model requests per file, and up to 45 usage polls per request.
Every HTTP request has a 60-second timeout. Existing accounts are never disabled
to force selection. If another account keeps serving, verification fails.

The tool prints counts and fixed failure stages only. Keep a private checklist
matching files to verified imports; never put account identities in public
evidence. On failure, inspect the destination pool before retrying. An upload
may have succeeded even when its response or verification failed. The tool
does not remove accounts or automatically retry a failed upload. Re-login only
where a token is dead. Remove temporary exports and the private input file once
the verified destination is the authority for the accounts.

## Set up every computer

For each computer, use **Set up this computer**, choose the owner's pool and
paste the generated prompt into its local agent. Use the current setup flow,
including its short-lived link and fallback command. Inspect the current config
first. Let setup back up each file it touches. Keep other providers and MCP
servers where the client supports several.

Restart Claude Code and Codex. Send a real request from each. Find and call a
tool through `signalbox` from each. Confirm the computer's fresh model and tool
observations in the computers list, and confirm the chosen pool's usage.
Check that Claude Code uses the new base URL, Codex selects the new provider
with `requires_openai_auth = true` and `X-Api-Key`, and both select the new
`signalbox` MCP server. Do not publish config contents.

Inspect any older unmarked entries separately. After backing them up, remove
only entries proven to target the retired setup. Never hardcode a known person's
old names or addresses into setup. Confirm no client still selects the old
model or tools endpoint. Keep a private row for every computer and client;
an unchecked row blocks shutdown.

Use the separate **Undo** paste if setup fails. It restores the backed-up state
and removes the marked changes. A live undo check belongs before shutdown,
while the old setup still exists; then re-run setup and verify v1 again.

## Shut down the old services

First recheck the coordinator's GO, the current deployment, imported account
requests and every computer's v1 observations. A changed or failing prerequisite
stops shutdown. Keep the exact resource inventory and deletion evidence outside
the repository. Anything shared with the runtime or Pumice is protected.
An unknown owner or dependency blocks deletion of that resource.

Use Executor's MCP tools and the repository host's tools. Do not use a browser
against real services. Work from exact resource identifiers in the private
inventory, never a name pattern or a whole-account cleanup command.

1. Stop only the old deployment producers, including their scheduled or push
   workflows, so they cannot recreate a retired service. Preserve any shared
   deployment job. Read back the workflow state.
2. Detach only dedicated old ingress routes, custom domains and DNS records.
   Verify each exact record or route is absent. Keep shared zones and domains.
3. Stop the dedicated old pool containers and tools workloads. Remove their
   container applications, Worker services and dedicated Durable Object
   namespaces in the dependency order recorded in the private inventory.
   Check instance lists as well as service definitions. A missing route alone
   does not prove a workload is gone.
4. Remove the dedicated storage and adapters after their last consumer is gone:
   D1, KV, R2, Hyperdrive and any external database listed in the inventory.
   A binding disappearing does not prove the underlying storage was deleted.
   Do not delete shared storage, database clusters, buckets or account-level
   secrets. Require a fresh consumer check before each removal.
5. Remove obsolete dedicated runtime and deployment secret entries last.
   Verify names only; never read or print values. Preserve every secret still
   used by Basalt, the runtime, Pumice or another active deployment.

For each resource, retain its type, owner, dependency check, removal result and
fresh absence query privately. Paginate all lists. Record errors and uncertain
results as unfinished. Verify the new model and tools requests again after each
service group is removed. If v1 fails, stop deletion and repair the new system;
deleted data cannot be recovered by undoing local setup.

Close the cutover issue only after the private inventory has no remaining
dedicated resources and all computers still serve requests through v1. Public
evidence includes revisions, check results and resource categories only. Exclude
credentials, account identities, old resource names, identifiers and hostnames.
