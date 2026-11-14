# Installation simplification — proposal only

Status: design, not an implemented whole-stack installer. Existing targeted
runtime provisioning and profile add-ons remain explicit maintenance tools.

## Proposed user flow

1. Choose a monthly budget, operating hours and a GPU/RAM profile. Show stopped
   disk cost, active hourly total, model download size and transfer costs before
   renting anything. Reject offers whose retained disk alone exceeds the cap.
2. Select an existing instance or approve one specific priced offer. Verify
   architecture, driver, available RAM and at least 2 GiB final disk headroom.
3. Deploy one signed, versioned release manifest: Harness, Strata, model digest,
   quantization, runtime/browser versions, service ports and migration version.
   A prebuilt runtime image avoids downloading compilers and Chromium at boot.
   Keep model weights on separately accounted persistent storage where supported.
4. Connect Tailscale and Cloudflare using their normal user authorization flow.
   Store provider credentials in Worker secrets and root-only server files;
   distribute only the narrowly scoped wake credential to an authenticated phone.
   Never put credentials into the release archive, URL query or Git repository.
5. Run one acceptance screen: real model answer, effective reasoning parameters,
   browser screenshot/console/WebGL, optional .NET compile, notification delivery,
   safe stop/wake cycle and estimated monthly cost. Show precise failures.

## Components and ownership

A provider adapter implements offer inspection, start, stop, readiness and
storage billing. The always-on Worker only authenticates and wakes the approved
instance. One server controller coordinates model, Harness, apps/VM and idle
shutdown. Opening a monitor must not extend compute billing. Sessions, sources,
databases and push registrations use persistent paths, with a documented backup.

Keep an installation journal outside the public release. Every step is
idempotent, records digests and has a rollback. Stage a release beside the live
one; activate only after the active-run count is zero. Preserve the previous
profile and service sources. Health checks must distinguish web availability
from model readiness. Interrupted provisioning resumes from verified artifacts.

## Packaging and cost controls

Publish one release archive plus a machine-readable manifest and checksums.
Use separate optional browser and .NET layers; no dependency installation in a
normal start. Cap source checkpoint retention and reserve disk space for apps.
Require explicit approval before changing rental price or deleting retained
project data. Report measured active time and retained storage separately.

Before implementing: prove recovery onto an empty instance, token rotation,
backup restore, mobile cold launch, queued-task safety and unavailable-capacity
behavior. Free-tier services provide no guarantee that an account or service
will remain available forever; the wake adapter must remain replaceable.

Actual validation found a stopped Vast GPU unavailable on resume. Treat this
as a required product state, not a generic connection timeout. Keep the UI
and project storage available independently of GPU allocation where possible.
When the provider returns HTTP 200 with a queued/rejected state transition,
show it explicitly and bound retries. Do not silently create billable fallback
rentals. The current whole-stack instance cannot offer guaranteed cold starts.
