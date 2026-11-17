# Shared runtime OS base (source proposal)

This directory defines one Debian linux/amd64 OS image for the existing editor,
executor, socket relay and egress proxy roles. It contains no toolchain payload.
The managed policy in `vast/apps-project-runtime-policy.cjs` continues to supply
the role command, UID/GID, read-only root filesystem, resource limits and scoped
read-only `/opt` toolchain mounts. This change does not enable or deploy it.

## Frozen public inputs

- Base: `docker.io/library/debian@sha256:7378260c0a098d27ac206225db5e7d92b8c7c84ea7afccc86eeb513756bbd392`.
  Registry manifest/config and the single public 29,856,132-byte layer were
  downloaded directly and checked without Docker pull. Gzip SHA-256 and plain
  tar diffID match the config. Tar inspection only: 3,271 entries, 2,678 regular
  files totaling 78,861,508 logical bytes; no extraction or content execution.
- Dockerfile frontend: official Dockerfile 1.27.1 linux/amd64 manifest
  `sha256:7b32114e84ca21aeb2d6f871a0b62b3a0762193f75d9afd048ee4cbe889f3148`.
  The syntax directive pins that digest rather than the moving `:1` tag.
  Verified registry index/manifest/config metadata identify revision
  `08f4630c67a49ff3158f218e99fd93ad97a90747`; its 14,277,824-byte layer
  has not been downloaded or executed. The builder needs that additional
  pinned public input before an offline build.
- Debian snapshot: `20261116T000000Z`, trixie, trixie-updates and
  trixie-security, main/amd64. The lock includes 170 exact package versions,
  architectures, archive SHA-256 values, sizes and snapshot URLs. Local filenames
  are canonical `NAME_ARCH.deb`; acquisition must rename the verified archive to
  that name. All 170 payloads were acquired into a new owned evidence input
  directory and passed SHA/size plus default-mode dpkg identity verification.
- Five public Debian keys and the three original signed InRelease documents are
  retained under `provenance/`. SHA-256 and primary fingerprints are pinned in
  JSON. GPGV verified every signature without ignoring unknown keys or errors.
  Compressed and plain Packages indexes matched the signed Release hashes;
  each selected package record matched that index. Trust is anchored in the
  pinned official Debian HTTPS key material; it is not an independent key audit.
- Isolated APT 3.2.1 `--simulate --no-install-recommends` used those verified
  indexes and an empty owned dpkg status, without host sources/status. The full
  closure is independent of which requested packages happened to be installed
  on the solver host. The immutable base also contains its own inherited OS
  packages; this lock pins the requested closure rather than claiming to replace
  the base's complete package inventory.

The 48 explicit requests cover shell/git/ripgrep/basic utilities, bundled
Node 24.22.1 native dependencies, .NET SDK 10.0.404 Debian 13 dependencies,
and the Chromium dependency list from the SRI-verified Playwright-core 1.65.1
Debian 13 x64 profile (Chromium 159.0.8154.6). The initial font profile includes
Liberation and Noto Color Emoji. It does not claim every optional Playwright font
or headed/Xvfb support. See the [Debian signing keys](https://ftp-master.debian.org/keys.html)
and [Microsoft Debian dependency list](https://learn.microsoft.com/en-us/dotnet/core/install/linux-debian?tabs=dotnet10).
Runtime compatibility remains an actual execution test after a separately
authorized build; package selection alone cannot establish it.

Metadata totals are 132,903,444 archive bytes and 527,558,656 Installed-Size bytes.
Neither is actual image size, allocated storage, VFS clone size or a guest disk
recommendation. No image build/run/export, VM start or Vast access occurred.

## Offline build contract

The future build context is this directory alone, with a new `packages/`
directory containing exactly the public files named in the lock. `.dockerignore`
excludes everything else. The Dockerfile binds these inputs temporarily; it
does not COPY them or any of T into a layer. JSON is the reviewable provenance
record; TSV is an exact generated projection, pinned by SHA-256 in Dockerfile.

`install-offline.sh DIRECTORY` only verifies. It checks the exact file set,
regular single-link files, byte size, hash and dpkg package/version/architecture
identity before the explicit `--install` build mode can act. Installation has
network disabled at the BuildKit RUN boundary, disables APT sources/downloads,
recommends and removals, preserves the base's pinned service-denial policy,
then verifies every installed
version and requires an empty dpkg audit. A base/closure conflict fails; there is
no force, unauthenticated package or downgrade fallback. No Docker pull/load or
build has occurred. Builder resource enforcement is still a separate prerequisite.

The exact base already has `/usr/sbin/policy-rc.d`: UID0/GID0, mode0755,
255 bytes, SHA-256
`21a8dca0d6a52cbac52cb7a86178d973616ffb42ea08747e6ff311659ab095e1`.
It exits 101 to deny service startup. The installer accepts only that regular
single-link file, keeps it in place, and preserves/restores its original bytes,
ownership, permissions and timestamp on success or failure. An absent,
unknown, linked or modified policy fails before APT. It never overwrites an
unknown host policy. Tests run only against new temporary public-file fixtures,
with UID0 needed solely to exercise the pinned ownership check.

All five `/opt` mountpoints are empty and read-only in the image. Existing
policy grants all five to editor/executor and only code-server/homeai to
relay/proxy. Role image configuration may select the same verified immutable
image ID after validation; this proposal does not mutate that configuration.
The image has UID/GID 1001 and the existing UNIX socket code-server config.
The policy remains responsible for its explicit launch command and writable
synthetic project/home/socket mounts. There is no default role entrypoint.

## Checks

On a Linux diagnostic host with Python 3, GPG/GPGV and dpkg-deb already present:

```text
python3 test_contract.py
python3 verify-provenance.py /path/to/public-metadata-directory
python3 verify-solver.py /path/to/public-metadata-directory
```

The second command reads `trixie-Packages.xz`, `trixie-updates-Packages.xz`
and `trixie-security-Packages.xz` from the supplied directory, uses a temporary
isolated GPG home, and never fetches packages. These large indexes are evidence
inputs rather than build context. The synthetic verifier tests construct only
an empty local test `.deb`; they never install it. `verify-solver.py` first
checks the provenance, then reproduces the exact 170-package selection with
isolated APT `--simulate` and a temporary empty status file. APT's simulation
mode performs no acquisition/installation; adding `--no-download` on APT3.2.1
would require absent payload files even for this metadata-only reproduction.

Passed locally: 12/12 tests, all 170 actual public package verifications and
all 170 provenance records. Actual Windows allocation of the 170 archives is
133,251,072 bytes; OCI manifest/config/layer files use 29,868,032 allocated bytes
(FileStandardInfo, excluding directory/MFT overhead). These are inputs, not an
image footprint. Future acceptance still
requires an actual image inventory and offline Node/npm/.NET/browser/editor
semantic tests under the existing role limits, followed by cgroup-v2/zero-swap
and physical VFS layer/clone/import/build-peak measurements. Existing Rancher
overlayfs with SwapLimit=false does not satisfy that guest acceptance contract.
