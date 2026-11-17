# Apps immutable-source validation under the service UID

`bindAppsProcess` runs in the unprivileged Apps process. Its default release
validator called `runtime.directoryTree`, which requires Linux root before
checking the directory. This prevented normal HOST Apps startup.

The default validator now uses only `lstatSync` and `realpathSync` on the release
directory and every ancestor. Each must remain a canonical real directory,
root-owned and not group/world writable. The existing exact immutable release
path, source SHA, inherited launch ID, validated projection and later binding
change checks are unchanged. No chmod/chown or privileged preparation occurs.
Existing direct trusted filesystem/directory seams remain source-only.

`vast/apps-execution-mode.test.cjs` exercises this DEFAULT validator without a
trustedDirectory stub, including unsafe ownership, modes, links, canonical
paths and failed metadata access. The complete suite passed 7/7 with no skips
on Linux under UID/EUID1000 using the existing installed SDK.

`vast/fixtures/apps-binding-nonroot.cjs` is an explicit read-only nonroot proof.
A trusted fixture owner prepares NEW root-owned public temporary trees; the
existing filesystem seam maps the fixed logical release path into them. Under
UID/EUID1000 with zero effective capabilities, the DEFAULT validator accepted
the protected tree and rejected actual writable/alias trees. Restoring only
the baseline727 default call in a private Module reproduced the original root
requirement failure. The reader changed no fixture metadata or files. Setup
and cleanup affected only that new `/tmp/homeai-apps-default-*` fixture; no
`/data/harness`, existing SDK permissions, live service or private data was used.

A related read-only review found no second root-only runtime-paths helper call
in the Apps startup/binding/admission chain. This is a local functional fix,
not guest activation, a privilege change, or production recovery acceptance.
