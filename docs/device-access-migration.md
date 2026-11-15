# Device wake access v2

This is a coordinated migration, not proof that the account or live Worker has
already been changed. Keep the source feature unmerged until the release owner
has an executable cutover for the edge and GPU services: signed startup follows
`main`, so merging phone v2 without its configured edge can break phone wake.

## Roles and persisted state

| Credential | Held by | Allowed use |
| --- | --- | --- |
| Newly rotated `WAKE_ACCESS_KEY` | Owner's private desktop/QR configuration and Worker secret | Owner portal login; signed owner cookie |
| `DEVICE_SIGNING_KEY` | Worker secret only | Sign limited device credentials; never returned |
| `DEVICE_ADMIN_KEY` | Worker secret and service-owned `wakeDeviceAdminKeyFile` | Paired provisioning, device list/revoke and approved claim; cannot approve reenrollment |
| v2 device credential | That browser's v2 credential store | `/api/status` and `/api/wake` only |
| Native cookie | HttpOnly browser cookie | Existing full Native owner access; independently validated by Native |

All three new secrets must differ. The GPU does not receive the device signer.
The old owner/wake key was historically exported to browser storage. Rotate it
at cutover, including its private desktop file and cached bindings; simply
turning off bearer access does not revoke the old key's owner-login authority.
Rotation also invalidates previously signed owner cookies. Do not print keys,
tokens, setup QR payloads or signed cookies in release evidence or CI artifacts.

`WakeDeviceRegistry` uses one SQLite-backed Durable Object named from the fixed
configured instance ID. It stores at most 50 device records, each with a hashed
pairing identity, generation, expiry and revocation/owner-approval timestamps.
No credentials are persisted in the registry. Tombstones remain present when
the browser clears its v2 storage. Unknown/corrupt state and missing bindings
fail closed. There is no KV eventual-consistency fallback or local auth cache.

The pairing hash uses only the exact Native authority cookie, validated alone
against Native. Adding language or arbitrary cookies cannot obtain a fresh
device. Tailscale auto-entry reuses an already authenticated Native cookie.
Explicit new Native owner authentication is a separate authority: revoking a
wake credential does not revoke Tailscale identity or full Native owner access,
nor identify a physical phone after all of its owner credentials are replaced.

## API and reenrollment

Paired routes enforce the existing Native authentication and POST origin rule:

| Route | Result |
| --- | --- |
| POST `/phone/api/wake-credential` `{deviceId:null|prior}` | `{version:2,wakeUrl,credential,deviceId,expiresAt,scope:['status','wake']}` |
| GET `/phone/api/devices` | Bounded metadata list and `ownerUrl`; no credentials |
| POST `/phone/api/devices/revoke` `{deviceId}` | Acknowledges only after edge persistence |
| POST `/phone/api/devices/claim-reenrollment` `{deviceId}` | v2 DTO plus verified owner-approval marker for that exact Native pairing |
| GET legacy `/phone/api/wake-config` | HTTP410 `AUTH_UPGRADE_REQUIRED`; never a key |

The owner portal is `/?devices=1`. It lists/revokes/approves without calling
the GPU or triggering wake. Its same-origin owner-cookie routes are POST
`/api/devices/list`, `/api/devices/revoke`, and `/api/devices/reenroll`.
Reenrollment requires both `deviceId` and matching `confirmDeviceId`. Its
response contains approval metadata, **not another device's credential**.
The server's admin key cannot approve reenrollment.

A revoked browser keeps its tombstone across reload. Only an explicit recovery
click calls the paired claim route. The server checks the original pairing and
the durable owner approval; only then does the browser replace its credential
and clear the tombstone. The marker is `{deviceId,generation,confirmedAt}` and
must match the stored device ID. Another revocation clears the owner approval.
An expired credential can renew once through a still-valid paired Native
session. If the GPU is asleep and no usable device credential remains, the
owner uses the independent owner portal to wake it before paired recovery.

## Account admission and configuration

Use the existing Cloudflare account and Worker. The release owner must record
the account identity, current **Workers Free** plan, current Durable Object
namespaces and remaining request/storage capacity from authenticated account
metadata or dashboard before provisioning. A dry-run does not prove these.
Do not select Workers Paid, add a subscription or expand paid capacity. If the
plan/features/quota cannot be verified, leave provisioning blocked and keep the
existing live release until admission is resolved.

Cloudflare documents SQLite-backed Durable Objects on Workers Free; free-limit
exhaustion fails operations rather than providing unlimited free capacity.
The application bounds records, has no alarms/background loop, and checks the
registry on each device authorization. Current plan details must be rechecked:
[pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

Merge these declarations into the existing private Wrangler configuration,
preserving its actual instance ID, URL, other bindings and any preexisting
class history. The example uses the supported declarative lifecycle flow:

```json
{
  "durable_objects": {"bindings": [{"name":"DEVICE_REGISTRY","class_name":"WakeDeviceRegistry"}]},
  "exports": {"WakeDeviceRegistry":{"type":"durable-object","storage":"sqlite"}}
}
```

Do not combine `exports` and legacy `migrations`, delete namespaces, or replace
an existing namespace with a new one to make tests pass. If the existing Worker
already uses migrations, review the documented transition before changing it.
[Class lifecycle configuration](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).
Supply all three secrets through the existing private secret-management path,
not `vars`, command-line literal arguments, logs or committed files.

On the GPU, replace `wakeKeyFile` with `wakeDeviceAdminKeyFile`, pointing to a
service-owned regular single-link0600 file containing only the admin key.
The service reads it with no-follow and a bounded size. Preserve the P1
telemetry path and private Harness log reader. Use `nativeAuthCookieName` only
for an explicitly reviewed Native adapter; default names follow the pinned
Native SDK's authority-hash cookie names.

## Cutover, verification and rollback

1. Finish independent review, exact-source tests, browser checks and bundled
   Worker dry-run. Record hashes/versions. Preserve the currently active Worker
   version, its private configuration, signed server source and existing data.
2. Verify Free admission and the exact production URL-to-instance mapping.
   Wait for an idle, available original GPU; do not interrupt owned jobs or buy
   a replacement. Resolve the separately reviewed root bootstrap migration.
3. In one bounded maintenance window, provision the SQLite namespace and
   distinct new secrets, rotate the historically exported owner key, and update
   private desktop/QR references. Deploy the reviewed Worker and immediately
   verify new owner login, rejection of old owner login/cookies, device-bound
   provisioning and authorization. Preserve owner access throughout the window.
4. Publish/activate the matching signed GPU/phone release with the admin-key
   reference. Verify Native pairing, v2 issuance, separate device revocation,
   failed automatic reenrollment, explicit owner approval and paired claim.
   Verify normal wake against the same fixed instance and fresh signed source.
5. Prove edge revocation while the GPU sleeps in a controlled idle window, and
   later re-check the same registry after edge restart/eviction. Local SQLite
   restart fixtures and intercepted browser tests are not this live proof.

If admission or verification fails, hold promotion. After the key rotation,
rollback must retain the new owner key and the registry/tombstones. Use a
reviewed owner-only secure fallback (device calls fail closed) or the last
reviewed v2 Worker; do not restore a release that exports the owner key or
accepts it as a device bearer. Code rollback is not registry deletion. Do not
restore an older registry snapshot that resurrects revoked credentials. Keep
new secrets private and preserve existing project/model/application data.

Completion requires sanitized evidence of exact edge/server commits and
artifacts, Free-plan admission, historical-key invalidation, real persistence
and device boundaries, and the actual live instance identity. Missing live
evidence remains pending even when local tests pass.
