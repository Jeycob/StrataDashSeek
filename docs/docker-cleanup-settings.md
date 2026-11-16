# Docker cleanup in Applications settings

The global Applications and Docker section contains resource inventory, an automatic archive-cleanup preference, and a manual selection/review/delete flow. Project-scoped panels do not expose these controls. The UI calls only `/api/workbench/docker-cleanup` using the existing authenticated same-origin connection.

Manual eligibility comes from `Resource.eligible` and `reasonCodes`. It is independent of `automaticEligible`: manual cleanup may select an unused resource belonging to an unarchived chat, while automatic cleanup remains restricted to archived owners. The preference is loaded from the server and saved using only `{op:"settings", enabled}`. A slow preference save is serialized with newer edits, and an older inventory response cannot overwrite a confirmed value.

The resource list uses server-provided display names, image tags, project names and chat titles as plain text, falling back to known application names or short ordinal labels when names are unavailable. It displays estimated or unknown sizes and localized protection reasons. Image selection includes its eligible container dependencies. Protected or newly unverified resources cannot be selected. Refresh preserves unaffected choices and invalidates a review whenever resource state changes.

Deletion requires a server preview of the explicit selection, followed by one apply using that preview's plan ID and hash. Stale/expired reviews are refused. The UI does not wake Docker, force-delete resources, delete volumes or retry an apply automatically. It polls running operations by ID. An uncertain known operation is reconciled by GET when the user refreshes; it is not applied again. Removed, already-absent and kept outcomes remain distinct. Deferred/unavailable/disabled states do not imply successful deletion.

Receipt responses must echo the original plan ID, hash and canonical selected set, plus the expected operation ID once known. A dropped apply response is recovered using `GET ?planId=<original>`; known operation reads include both operation and plan IDs. Global latest-operation metadata is ignored. A tab-scoped recovery hint stores only this request identity before the single apply fetch, survives page reload when session storage is available, and is cleared only after validating that request's terminal receipt. Missing, foreign or unverifiable receipts remain unconfirmed and do not cause another apply. This hint does not store the automatic-cleanup preference or confer deletion authority.

Deferred, running and uncertain receipts retain already-confirmed results. Removed, kept, already-absent, uncertain and entries without a result are counted separately; an interrupted operation never claims that nothing was deleted. A mismatched initial poll leaves the Refresh action available for exact recovery.

## Validation and release ownership

`mobile/apps-cleanup.browser.test.cjs` exercises the real Settings DOM and stable-v1 HTTP payloads against a local fixture: protected selection, image dependencies, preview/apply binding, preference races, stale reviews, deferred/error/reconciliation states, asynchronous results, destruction, keyboard input and 390/1440px layout. This is browser fixture evidence, not a production GUI or live Docker cleanup result.

Local acceptance also connected the real `installDockerCleanup` workspace HTTP adapter and `ArchivedDockerCleanup` controller to this browser UI. Only the owner registry/session persistence and Docker API were synthetic. It verified a manual unarchived-owner container deletion, retention of the image, and preference persistence across controller reconstruction. Apply and reconciliation requests use the backend's bounded 180-second deadline; status reads retain the 20-second timeout. This does not establish live daemon readiness or authorize additional production changes.

The release owner must integrate the backend implementation and rebuild `workspace/native-ui/client.js` with the existing builder, then run the release checks and deploy. This branch deliberately changes source and tests only; it does not regenerate the checked-in Native bundle or change production.
