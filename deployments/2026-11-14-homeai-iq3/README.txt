Deployed configuration snapshot, 14 November 2026.
Captured from the running Vast instance after HomeAI parity deployment and cold-start verification.
Secrets, browser credentials, histories, VAPID keys/subscriptions and model weights are excluded.
OWNER_TAILSCALE_LOGIN must be restored from private configuration before using push-config.json.
The ordinary provider route is loopback 8088; the temporary acceptance proxy is not deployed.
Strata saved args contain legacy MTP-derived flags, but drafting=dflash2 causes the wrapper to use
DFlash2. Native metrics and the running command verified DFlash2. Do not infer active drafting
from the raw derived args alone.
Restore only while no user task is active. Preserve private keys, profile credentials and Tailscale
state on the machine. The removed IQ2 weight files are re-downloadable, not included in rollback.
This snapshot is evidence for configuration and the listed tests, not a guarantee of arbitrary
task quality. The benchmark and failed/invalid test fixture limitations are recorded in verification.json.
Before any further production configuration/version/hardware promotion: commit and push a fresh
sanitized snapshot, run the bounded experiment, then record the outcome and rollback or promote.
