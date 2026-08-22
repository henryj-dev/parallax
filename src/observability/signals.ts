import { counter } from "./metrics.ts";

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
