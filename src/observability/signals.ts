import { counter, histogram } from "./metrics.ts";

/**
 * The counters this process keeps, declared in one place.
 *
 * Each one is here because there is a failure it is the only warning of. The
 * stderr line that accompanies it tells a person what happened; this is what a
 * deployment can put a threshold on.
 */

/**
 * A stored record the wire could not carry.
 *
 * The one this whole file exists for. Content that encodes to more than 65535
 * bytes used to make the query vanish -- no reply, no log. It answers SERVFAIL
 * and prints a line now, and this is how anybody finds out without reading it.
 */
export const recordUnservable = counter(
  "parallax_dns_unservable_records_total",
  "Stored records the DNS listener could not put on the wire.",
);

/**
 * A reply that could not be assembled after every per-record guard passed.
 *
 * Distinct from the above because it names no record: by then the failure is in
 * the message, not in a row. Rare enough that any value above zero is worth
 * looking at.
 */
export const replyUnanswerable = counter(
  "parallax_dns_unanswerable_replies_total",
  "Queries answered SERVFAIL because the reply could not be assembled.",
);

/**
 * A zone left out of the listener's snapshot because its views would not
 * compose. The name keeps resolving through the forwarder, if there is one --
 * which is why nobody notices until they ask why the override is not working.
 */
export const zoneSkipped = counter(
  "parallax_dns_zones_skipped_total",
  "Zones left unanswered because their internal view could not be composed.",
);

/**
 * A background refresh that failed.
 *
 * These loops are what keep a revoked token revoked and a changed setting
 * applied, and a failure leaves the previous view in place on purpose -- so
 * failing forever looks exactly like working until something is wrong.
 */
export const refreshFailed = counter(
  "parallax_refresh_failures_total",
  "Background refreshes that failed, by subsystem.",
);

/** NOTIFY is best-effort, so a secondary going unnotified is otherwise silent. */
export const notifyFailed = counter(
  "parallax_dns_notify_failures_total",
  "NOTIFY messages that could not be sent.",
);

/**
 * A TLS certificate that could not be read after it changed on disk.
 *
 * The process keeps serving the one it has, which is right, and means the only
 * symptom is an expiry months later.
 */
export const certificateReloadFailed = counter(
  "parallax_tls_certificate_reload_failures_total",
  "Certificate reloads that failed, leaving the previous certificate in use.",
);

/**
 * What the listener answered, by rcode.
 *
 * The counters above are failure-only by design, and that rule earns its keep:
 * each one is the sole warning of something. This is the one number they
 * cannot supply between them -- without a denominator, "three SERVFAILs" is
 * either a catastrophe or a rounding error and nothing says which. The rcode
 * label is a small fixed set, and it carries no name and no address.
 */
export const dnsAnswered = counter(
  "parallax_dns_answers_total",
  "Replies the DNS listener sent, by response code.",
);

/**
 * How long a relayed query took, including the upstream that answered it.
 *
 * Buckets in seconds, chosen around the 4s default forward timeout: a resolver
 * is fast or it is a problem, and the interesting boundaries are all below it.
 */
export const dnsForwardSeconds = histogram(
  "parallax_dns_forward_seconds",
  "Time to relay one query to an upstream and read its answer.",
  [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 4],
);

/** Forwarding failures, split by configured upstream index and bounded reason. */
export const dnsForwardFailures = counter(
  "parallax_dns_forward_failures_total",
  "DNS forwarding failures by configured upstream index and reason.",
);

/**
 * Empty local answers asked of the upstream, by what came of it.
 *
 * `relayed` is the upstream's answer given in place of ours; `local` is ours
 * given anyway because the upstream did not answer. A rising `local` share is
 * the fallback quietly not working -- the client still gets an answer, so
 * nothing else would say so.
 */
export const dnsFallback = counter(
  "parallax_dns_fallback_total",
  "Empty answers in fallback zones that were asked of an upstream, by outcome.",
);

/**
 * A pass of the provider-only check that could not read a zone's provider.
 *
 * The gauge beside it keeps its last value when that happens, so this is the
 * only sign that the number has stopped being current.
 */
export const dnsDriftCheckFailed = counter(
  "parallax_dns_drift_check_failures_total",
  "Zones whose provider records could not be read by the provider-only check.",
);

/** Answers the API sent, by status. A bounded set: this code chooses them all. */
export const httpAnswered = counter(
  "parallax_http_responses_total",
  "HTTP responses the API sent, by status code.",
);

/** Buckets around what a control-plane call should cost, provider calls aside. */
export const httpSeconds = histogram(
  "parallax_http_request_seconds",
  "Time to answer one API request.",
  [0.005, 0.025, 0.1, 0.5, 1, 2.5, 5, 10, 30],
);
