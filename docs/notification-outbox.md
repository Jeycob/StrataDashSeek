# Durable notification queue

The phone service persists notification intent before responding HTTP 202.
The response's `persisted:true` acknowledges that write, not provider acceptance
or phone delivery. `queued` reflects pending targets; an expired event, event
with no registered recipients or completed duplicate can be persisted without
being queued. The watcher advances its durable cursor and pending intent before
posting, and removes pending intent only after a durable receipt.

## Storage and recovery

`notification-outbox.sqlite` lives in the service-owned private subscription
directory, beside the existing private Web Push files. It uses Node 24's SQLite,
WAL, synchronous FULL, an application/schema identity and one transaction per
enqueue/claim/result. An unknown database is refused, never reset. Keep the
existing two-GiB storage reserve. The final path must be a regular single-link
file in a private service-owned parent. Do not point candidate tests at the
production subscription directory.

Existing SQLite WAL, SHM and rollback-journal sidecars must also be regular,
single-link, privately permissioned files owned by the service. Unsafe sidecars
are refused before opening SQLite; retained targets are not modified. This is
a boundary inside the service's private directory, not isolation from another
process running as that same service user.

An event ID has one immutable category and recipient snapshot. Its per-recipient
attempt count, lease, retry deadline and provider result survive service restart.
Duplicate enqueue returns the original persisted receipt and never adds later
subscribers. Targets are limited to 50, events to 2048 and retained for 24 hours.
When full, new enqueue fails explicitly; an already persisted duplicate can
still be acknowledged without allocating another write.

Defaults are five attempts, a five-minute delivery TTL, ten-second send timeout,
and bounded exponential backoff with jitter up to 60 seconds. Expiry uses the
original event time when the watcher supplies it. A crashed sender's attempt
lease expires before another sender reclaims it; the attempt budget is retained.
Lost provider acknowledgments can cause a repeated send: the contract is
at-least-once attempts, not exactly-once delivery. A stable event notification
tag lets the browser replace repeated copies of that event.

HTTP 404/410 retires the subscription in the durable queue. Later events exclude
it even if a legacy JSON cleanup did not happen. Saving an explicitly renewed
valid subscription reinstates future events and invalidates old in-flight
attempts; a late 410 cannot retire the replacement. Disabling a subscription
durably retires queued attempts before removing its JSON registration. Private
JSON updates now sync their file and, on Linux, its parent directory.

Replacement first durably fences old attempts, then persists the new JSON and
reactivates the subscription. If any persistence step is uncertain, the request
fails and the registration remains retired, including after restart. An explicit
successful subscription retry is required; an old in-flight provider response
cannot reactivate or overwrite this pending state.

The test-notification delay and one-minute rate limit are also persisted. A
restart during the five-second delay does not lose or duplicate the test.

## Watcher cursor

`notification-watcher-state.json` defaults to the internal key's private
directory. The watcher holds a persistent OS lock; it never deletes a lock file
based on a timeout. State snapshots use exclusive random staging, file sync,
atomic replacement and Linux parent sync. Cursor and pending event state are
one snapshot, so a crash between receipt and local acknowledgment re-posts the
same event ID safely. Corrupt, linked, oversized or unsupported state fails
closed and remains available for operator recovery.

Only first installation baselines preexisting history. Later starts resume
saved cursors, including completions during downtime. Pending attention and
resolution survive restart. Already expired pending notifications are dropped
according to the notification TTL. State is bounded to 10000 cursor entries,
2048 pending intents and eight MiB; message bodies and generated code are never
sent to the phone service. Compression support remains the pinned production
`zstandard` dependency or Python's compatible standard-library implementation.

## Status and deployment

`outbox.providerAcceptedTargets` means the provider returned a successful HTTP
status. `deliveryConfirmed` is always false: Web Push acceptance cannot prove
that Safari displayed a notification or that a person read it. Legacy `accepted`
is an alias for retained provider-accepted targets. Status also reports queued,
failed, retired and expired target counts; these are not task-quality scores.

Deploy the matching phone service and watcher together in an idle maintenance
window. Preserve VAPID identity, subscriptions, the internal key, queue database
and its SQLite WAL/SHM files, and watcher state. Do not copy an active SQLite
database without an appropriate SQLite backup/checkpoint procedure. No automatic
data export or deletion is part of this change.

On failure, stop the affected service and preserve the entire private state.
Use a reviewed compatible reader/writer version or hold enqueue unavailable;
rolling back to a memory-only service would discard the durability contract.
Code rollback does not imply resetting queue data or watcher cursors. Live iPhone
delivery, production restart and actual hardware acceptance remain separate
verification from local crash, HTTP, compressed-record and browser fixtures.
