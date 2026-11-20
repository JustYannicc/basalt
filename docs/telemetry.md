# Feedback and telemetry

What the feedback form, error reporting, request timings and product analytics send, and where.

`SENTRY_DSN`, `SENTRY_OTLP_ENDPOINT`, `POSTHOG_PROJECT_KEY` and `POSTHOG_HOST` are optional GitHub Actions settings. The DSN enables the feedback form and error reporting. Copy the exact direct OTLP trace endpoint from that project's Client Keys settings into `SENTRY_OTLP_ENDPOINT`; the DSN alone does not select a trace endpoint. Both Sentry settings must use the same EU ingestion host. `POSTHOG_PROJECT_KEY` selects the product analytics project. Set `POSTHOG_HOST` to that project's exact `https://us.i.posthog.com` or `https://eu.i.posthog.com` ingestion origin. Omission preserves the EU default. Product analytics currently uses an existing US project; Sentry remains in the EU. Missing settings disable the corresponding feature and produce a deployment warning.

The dashboard sidebar's Feedback form (carry 0047) sends what the person writes, their authenticated account ID and a fixed page label to Sentry. Unless the person unticks them, it also attaches a screenshot of the page, captured in the browser when the form opens, and recent page logs: up to 50 console errors and failed requests from this page load, as method, path, status and timing, within 16 KB. The browser keeps those logs in memory only and redacts them as it records them: no request or response bodies, headers, cookies, query strings or fragments, and tokens, keys, long hex or base64 strings and email addresses are replaced. The feedback host checks their shape and caps and redacts them again before sending them as a `logs.json` attachment. Agent feedback uses the same destination. Feedback text, screenshots and logs never enter product analytics. The deployment sets the form's endpoint only when a valid feedback destination is configured, so the sidebar shows no Feedback entry otherwise.

Product events use opaque account IDs and a closed property allowlist. Catalog misses carry a known service identifier only when the local catalog yields one unambiguous match; the raw query never leaves the tools service. Product analytics never receives names, email addresses, credentials, tool arguments, results or model content. Browser autocapture and person profiles are disabled. All vendor requests originate in Workers and omit client headers.

Each request the pool forwards to its runtime produces one timing event. It says how long the request spent:

- in the Worker before the pool's Durable Object was called (`workerMs`);
- only when the Worker sent the request to the object again, after a call the platform said to retry: the failed call and the wait before the next one (`replayMs`). If the failed call reached the object, that attempt may have its own event;
- waiting for that object's handler to start, including the network hop to it (`queueMs`);
- in admission: the organization check, identity and membership (`admissionMs`);
- in dispatch: runtime readiness, protection and routing, including retries (`dispatchMs`);
- between handing the request to the runtime and its response headers (`firstByteMs`), or until it failed without answering (`unansweredMs`);
- in the response body (`streamMs`), only while model history observes that body.

`totalMs` is their sum, and `durationMs` is evlog's own measure of the time inside the forwarding step (near zero on an event the Worker reports). The dispatch stages Home reports arrive as `home…Ms` fields, with `homeFaults` naming a stage that did not finish. The event also has a closed `outcome`, the response status, the response size when the body was observed, and the guard and cause of a refusal.

To group a burst it carries the pool's request ID, a trace ID, the runtime's boot ID, the number of model streams already open and `poolRef`, a short hash of the pool's ID. The request ID is the `X-Request-Id` the caller received on a model call; a runtime's refusal answers under its own ID, recorded as `responseRequestId`. A valid `traceparent` from the caller is continued, so its trace ID is the caller's. Nothing else from a request or a response enters the event: no path beyond a fixed route label, no other header, no body, no model name, no person and no key.

The event is written to Workers Logs. When both Sentry settings are present and the trace is sampled, it is also sent to Sentry as one trace: the event's fields on the request's span and one child span per step that took a millisecond or more.

A call that fails without an answer from the Durable Object is reported by the Worker, with one of these outcomes. After a replay, the outcome and the wait describe the last call.

- `controller_unavailable`: the object never ran it, for example because it is overloaded. The wait is `queueMs`.
- `controller_failed`: the object's own code threw. The wait is `unansweredMs`, because the Worker cannot tell queueing from work there.
- `controller_reset`: the call failed in a way the platform says to retry, for example because the object's instance ended, and no second call was answered. The wait is `unansweredMs` for the same reason. If the Worker answered with retry advice or an unknown outcome, the event carries that answer's status and `X-Request-Id`.
- `client_closed`: the caller disconnected while its request waited for the object. The wait is `unansweredMs`. Such a caller may also leave no event.

These requests produce no event: one refused for a missing or invalid key, one the Durable Object answers without forwarding, and the Worker's own prewarm. Nor does a stream the object had started answering when its instance ended: the Worker saw an answer, and the object that would have reported it is gone. Its `POOL_CONTROLLER_INTERRUPTED` log line remains.

A request from another app through the pool's app-model route has no `workerMs` or `queueMs`, and its admission starts when forwarding does. A refusal the routing layer builds after a runtime failed to answer counts as `unansweredMs`. Inside a fleet, the wait for a runtime's own Durable Object is part of `firstByteMs`.

The activation funnel uses `sign_up`, `pool_created`, `account_connected`, `setup_started` and `first_model_request`, in that order. `setup_completed` follows successful model and MCP tool observations and can be measured after first use. Local tests prove event shapes, authenticated web and agent feedback delivery to a capture server, redaction and Worker compatibility. Actual vendor ingestion, EU project configuration and a real activation funnel require live acceptance after deployment.

API Worker size checks enable the optional destinations with synthetic settings. The upstream cold-start budget remains 5,450,000 bytes of uncompressed JavaScript. Vendor SDKs are not added by the destination patches; the router uses small HTTP transports. Direct Sentry error and trace exporters send fixed codes, fixed route labels and closed attributes, never exception text. Cloudflare platform trace export is disabled in this mode because it can include raw URLs or IP addresses.
