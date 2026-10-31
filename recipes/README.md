# Default check workflows

These are three ordinary apps: production checks, pool-owner checks and personal
connection checks. Install a private copy from the catalog. Its source, tools,
workflow history and schedule controls are the existing app features. Updates to
the defaults do not rewrite customized copies.

Link your existing Signalbox management account in the copy's Accounts tab. The
watched accounts are target IDs, not required credentials on this app. A broken
watched connection therefore does not prevent the monitoring app from starting.
The source API credential itself still has to work.

Edit `common/configuration.ts` in your private copy. Set its organization and
watch targets, then select the exact send tool from an app you have connected.
`channel.input` builds that tool's ordinary input from the fixed nudge and review
URL; `channel.receipt` extracts its documented opaque receipt. Gmail, Slack,
Cloudflare Email Sending or another connected tool can be used. There is no
operator address or default destination. Do not put credentials in the source.
The channel's existing policy must permit the agreed unattended send. A workflow
form answer does not authorize a protected tool.

Run `configure` with `deliveryEnabled: false`, then use Run now on its schedule.
Inspect the read results and Approvals question before approving delivery and
enabling the schedule. Delivery consent is bound to a hash of this copy's
configuration, including its selected channel formatter. Changing it requires
configuring the copy again; retained older runs cannot use the new consent to
send to an old destination. Schedules start paused and delivery starts off. This
repository does not configure or activate production copies.

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

Quiet hours have no default timezone. Set them explicitly if wanted. They defer
the nudge while the question remains in Approvals. `mute` takes a UTC timestamp;
`unmute` reverses it. Declining the form ends that proposed action until recovery.
Deferring sets a wake time and the next scan rechecks the facts before asking
again. Pausing a schedule stops future scans; existing waiting workflows remain.
Turn delivery off and terminate those runs when immediate cancellation is wanted.

A send can be accepted even when its reply is lost. That episode keeps its claim
and reports `delivery-uncertain`; do not retry it or switch channels blindly.
Reconcile it using the provider's receipt/history. `retryRefusedDelivery` works
only after an identified refusal before execution, never after an ambiguous send.
Saving an answer is shown separately from a verified healthy resource.
The send callback commits its submission claim before calling the connector. If
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
come from completed reads, independently of retained workflow history. A failed
or stalled read needs attention once it exceeds the configured age. A missing or
unconfigured watch stays unknown.

An approved budget and complete authorized service-wide capacity inventory are
not supplied here. Those workflows report unconfigured. Forecast shortage still
requires the pool's planned public forecast query. A same-host workflow cannot
notify during a full host outage; use an already independently hosted monitor
or the vendor's native notifications for that boundary.
