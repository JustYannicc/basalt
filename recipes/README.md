# Default check workflows

Workflows can ask for explanations in free text, select a choice, confirm or decline a
proposal, collect an amount or date, or ask someone to reconnect an account and then
verify it. `workflowInputQuestions` from `apps` supplies those defaults. Each returns
an ordinary editable `form` and a `display` hint; pass it with `timeoutMs` to
`ctx.step.requestInput`. Text, choice, number and date answers use `content.value`.
Confirm and reconnect use the standard accept, decline or cancel action. Reconnection
still needs a fresh check of the account.

A workflow can supply any supported MCP form schema directly. For a custom display,
`display: { kind: "mcp-app", view }` retains the existing MCP Apps view observation
with its source, selection, input and `ui://` resource URI beside the form fallback.
The encrypted request stores this data without a separate SQL column. Human in the
loop resolves custom displays through the existing authenticated MCP Apps resource
and callback paths. The descriptor grants no access and cannot answer the question
for the person. The standard form remains available.

These are three ordinary apps: production checks, pool-owner checks and personal
connection checks. Install a private copy from the catalog. Its source, tools,
workflow history and schedule controls are the existing app features. Updates to
the defaults do not rewrite customized copies.

Link your existing Signalbox management account in the copy's Accounts tab. The
watched accounts are target IDs, not required credentials on this app. A broken
watched connection therefore does not prevent the monitoring app from starting.
The source API credential itself still has to work.

Edit `common/configuration.ts` for this copy's organization and watch targets.
Each named workflow's `destination` and `quietHours` live in
`common/workflow-fields.ts`. Edit the workflow's fields to change its behavior;
there is no shared destination or quiet-hours preference. The default destination
is Human in the loop with external nudges off. Personal connection nudges default to
quiet hours from 22:00 to 08:00 in Europe/Zurich; pool and production workflows
have no quiet hours. Quiet hours affect external nudges, never the inbox item.

For email or Slack, change that workflow's destination to `kind: "tool"`, with
the existing connected app and its exact send tool. Its `input` builds the tool's
ordinary input from the fixed nudge and review URL; `receipt` extracts its
opaque receipt. Credentials remain in normal account connections. The tool's
existing policy must permit the agreed unattended send. Answering a workflow
question does not authorize a protected tool.

For the inspected structured Gmail sender, use `kind: "self-email"` with the exact
app, saved account ID and your verified owner address. Save that workflow's
`alert_<workflow name>` dependency connection to the same app and account. Read
`settings`, then include its exact `deliveryScope` in the owner-approved `configure`
call when enabling delivery. The host checks the current source, target and account
generation, and only that workflow's named send step can use the permission.
CC, BCC, replies and uninspected sender implementations keep requiring approval.
Changing the source, connection, target version or account generation requires
confirmation again. Turning delivery off stops subsequent submissions.

Customized copies keep their source. When updating one manually, move its former
`configuration.channel` and `configuration.quietHours` values into each affected
workflow's fields, preserving its destinations and timing before removing the
shared fields. An update to the catalog never resets a customized copy.

Run `configure` with `deliveryEnabled: false`, then use Run now on its schedule.
Inspect the read results and pending workflow input before approving delivery and
enabling the schedule. Delivery consent is bound to a hash of this copy's
configuration, including each workflow's destination formatter and quiet hours. Changing it requires
configuring the copy again; retained older runs cannot use the new consent to
send to an old destination. Schedules start paused and delivery starts off. This
repository does not configure or activate production copies.

Workflow questions appear in Human in the loop, the public workflow-input APIs
and native workflow history. Hosted answers require the recipient's browser
session; a tool or API key cannot approve a question for them. Keep a dry-run copy
paused unless the recipient has a verified way to inspect and answer its questions.
A workflow using only Human in the loop needs no external channel setup.

Use a separate private copy for each owner. These recipes bind their SQL state
to the person who configures them. Do not share a copy containing private watch
or destination configuration. A pool owner never receives another person's
Reconnect permission. Native account and pool pages enforce who can act; the
workflow rechecks the actual result after the person chooses Recheck.

Each failure episode claims one nudge. Unknown/stale quota and temporary account
errors stay quiet. Quota confirmation needs two distinct fresh sets of readings,
and recovery needs two above 20% in every blocking window. Cached collection
results never count as another observation. The low and exhausted states use
one episode. The existing collection cap is preserved.

Pool account checks compare the authorized pool inventory with their prior reading.
A missing account asks the owner to review the pool only when capacity is impaired.
Removal through the native pool controls stays quiet. Missing or truncated removal
history stays unknown. Three distinct non-transient failed checks spanning at
least 30 minutes can ask the owner to review or pause that account. Rate limiting
and provider outages do not become reconnect requests. Pausing and resuming the
account remain native pool actions.

The pool-owner copy also checks contributed-account departure cleanup once per
minute for each distinct watched app, across provider groups. A terminal eighth
failure or cleanup pending for at least five minutes opens one Human in the loop
question with the pool, affected account, job, attempts and fixed last-error kind.
Older jobs label missing enqueue times and error diagnostics as unknown. The read
requires current app management access and returns at most 100 remaining links.
An incomplete read cannot establish recovery. The workflow observes cleanup; it
does not retry detachment or delete saved accounts. Lost source access withdraws
the question. Removing a member already blocks their native pool use before this
physical cleanup completes.

Each workflow's quiet hours include an explicit timezone. They defer the nudge while the workflow input remains pending. `mute` takes a UTC timestamp;
`unmute` reverses it. Declining the form ends that proposed action until recovery.
Deferring sets a wake time and the next scan rechecks the facts before asking
again. Pausing a schedule stops future scans; existing waiting workflows remain.
Turn delivery off and terminate those runs when immediate cancellation is wanted.

A send can be accepted even when its reply is lost. That episode keeps its claim
and reports `delivery-uncertain`; do not retry it or switch channels blindly.
Reconcile it using the provider's receipt/history. `retryRefusedDelivery` works
only after an identified refusal before execution, never after an ambiguous send.
Saving an answer is shown separately from a verified healthy resource.
The send callback commits its submission claim before calling the connector.
That transaction requires the callback's configuration revision to match both
the active build and stored consent. A reconfigure after preflight refuses the
old callback before it submits; a safe retry requires the owner's normal approval. If
that callback replays after a lost receipt, it cannot acquire another submission.
An interrupted attempt stays uncertain even if it stopped before sending. A
replayed preflight refusal cannot change an earlier submission into a safe retry.

Production metric readers are deliberately explicit. The GitHub release reader
expects the documented `workflow_runs` response from the selected production
workflow and branch. Runtime, HTTP and event-count readers require verified safe
projections from an existing permitted connector query. Their checks in
`operator/reads.ts` name the fields, freshness and exclusions they require. A
missing query or denominator returns unknown/unconfigured; HTTP 401 and Worker
invocation success are not readiness evidence. Do not enable those schedules
until their actual connector contract is verified.

For workflow health, list each watched recipe app, its expected workflow names
and the maximum successful-scan age in minutes. Include schedule slack. The
check reads current delivery checkpoints while a question waits, and detects
missed successful scans separately from legitimate human waits. Scan timestamps
come from completed reads, independently of retained workflow history. A complete
fresh read counts while its condition awaits confirmation. A failed
or stalled read needs attention once it exceeds the configured age. A missing or
unconfigured watch stays unknown.

An approved budget and complete authorized service-wide capacity inventory are
not supplied here. Those workflows report unconfigured. Forecast shortage still
requires the pool's planned public forecast query. A same-host workflow cannot
notify during a full host outage; use an already independently hosted monitor
or the vendor's native notifications for that boundary.
