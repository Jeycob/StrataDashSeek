# Immutable project toolchain

This is a source-only offline packaging recipe and validator. No real artifact
has been built, downloaded, exported, sized or smoke-tested by these changes.
Synthetic tests do not establish a working browser, .NET, network proxy or editor.

`project-toolchain.cjs` exports the synchronous host admission API:

```js
verifyToolchain(root, {expectedDigest, expectedUid: 0})
// {version:1, root, manifestSha256, dev, ino, uid, gid}
```

Production always requires UID 0. A different expected UID exists only for
unprivileged synthetic tests. The protected controller configuration pins the
canonical versioned root and the exact SHA256 of `.homeai-toolchain.json`.
The validator hashes every regular file, checks ownership and modes, refuses
special files, hardlinks, escaping/absolute symlinks, private/SDK paths and
unlisted entries, and checks package versions, browser revisions, fixed npm
wrappers and Linux x64 ELF entry points. It never executes the tree.

Default bounds: 100,000 entries, 8 GiB aggregate regular-file bytes, 2 GiB per
file, depth 48, 32 MiB manifest and a cooperative 15-second hashing deadline.
A caller must still impose a hard outer deadline for blocking filesystem calls.
Validate once before opening the immutable read-only export descriptors; do not
rescan a multi-gigabyte tree on every tool RPC. A owns descriptor caching,
protected configuration and revocation when the versioned root changes.

## Layout and prerequisites

The five top-level directories are exported read-only at the matching paths:

| Tree | Guest mount | Contents |
| --- | --- | --- |
| `code-server` | `/opt/code-server` | Verified code-server 4.145.2 and bundled Node 24.22.1 |
| `homeai` | `/opt/homeai` | Exact quality/development dependency closure and three transport launchers |
| `dotnet` | `/opt/dotnet` | Verified .NET SDK 10.0.404 |
| `playwright` | `/opt/playwright` | Playwright/core 1.65.1 and explicitly pinned browser archives |
| `npm` | `/opt/npm` | Verified npm 12.2.2 with fixed Node wrappers |

The base container must separately provide a compatible glibc loader and the OS
libraries required by Node, .NET and the selected Playwright browsers, plus
`/bin/sh`, Bash, Git, ripgrep, CA certificates and normal container runtime files.
This package is not a root filesystem and does not claim that these dependencies
or Chromium sandbox support have been accepted. Do not use host `/usr` binds to
fill gaps. Actual isolated smoke tests remain required before activation.

Set these fixed executor values in A's trusted policy:

```text
PATH=/opt/code-server/lib:/opt/code-server/bin:/opt/npm/bin:/opt/dotnet:/usr/bin:/bin
HARNESS_PLAYWRIGHT_MODULE=/opt/playwright/node_modules/playwright
PLAYWRIGHT_BROWSERS_PATH=/opt/playwright/browsers
DOTNET_ROOT=/opt/dotnet
DOTNET_CLI_TELEMETRY_OPTOUT=1
```

`npm/bin/npm` and `npm/bin/npx` invoke `/opt/code-server/lib/node` explicitly.
The guest doctor is a deterministic installed variant of the trusted source:
its four host paths map to fixed `/opt` tool paths and `/tmp/homeai-development`.
The original Native doctor is unchanged. The manifest records both original and
installed source hashes. No whole Harness tree, SDK, Apps configuration, machine
identity, key, user home or credential directory is copied.

## Offline operator recipe

Use a separate Linux x64 staging environment with Node 24, Python 3.12+, Git,
UID 0 and enough measured capacity for the inputs, extracted tree and temporary
files. The builder does not fetch anything or alter a running VM. Its output
must be a **new** canonical directory under an existing trusted parent.

`project-toolchain-lock.json` fixes known artifact pins. Playwright/core pins are
also checked against `development/ci/package-lock.json` from the selected trusted
source commit. npm's primary registry metadata evidence is maintained by the
coordinator; its unpacked-size field is not a measured deployment footprint.

The source commit must contain all `SOURCE_FILES` listed in
`project-toolchain.cjs`, including the latest egress launcher/proxy, the lock file
and the audited quality imports. Unlisted literal dependencies fail packaging.
The builder never copies a working tree or reads untracked project files.

Example recipe (browser placeholders must be replaced with reviewed existing
cache artifact hashes and paths; the builder rejects missing or invalid pins):

```json
{
  "version": 1,
  "sourceRepo": "/trusted/source-checkout",
  "sourceCommit": "<exact-40-hex-trusted-commit>",
  "artifacts": {
    "codeServer": "/offline/code-server-4.145.2-linux-amd64.tar.gz",
    "dotnet": "/offline/dotnet-sdk-10.0.404-linux-x64.tar.gz",
    "npm": "/offline/npm-12.2.2.tgz",
    "playwright": "/offline/playwright-1.65.1.tgz",
    "playwrightCore": "/offline/playwright-core-1.65.1.tgz",
    "browsers": [
      {"name":"chromium","revision":"<pinned-browsers.json-revision>","file":"/offline/chromium.zip","sha256":"<reviewed-64-hex>","executable":"playwright/browsers/chromium-<revision>/<actual-relative-ELF-path>"},
      {"name":"chromium-headless-shell","revision":"<pinned-browsers.json-revision>","file":"/offline/chromium-headless-shell.zip","sha256":"<reviewed-64-hex>","executable":"playwright/browsers/chromium_headless_shell-<revision>/<actual-relative-ELF-path>"},
      {"name":"ffmpeg","revision":"<pinned-browsers.json-revision>","file":"/offline/ffmpeg.zip","sha256":"<reviewed-64-hex>","executable":"playwright/browsers/ffmpeg-<revision>/<actual-relative-ELF-path>"}
    ]
  }
}
```

Run only after the operator has reviewed the concrete inputs and capacity:

```sh
node development/project-toolchain-build.cjs /trusted/recipe.json /trusted/toolchains/new-version
```

Every archive is opened read-only with no-follow, hashed against its pin, and
passed by inherited FD to the bounded extractor. Extraction writes only a new
exclusive component directory, refuses traversal, outside links, hardlinks and
special types, and runs no package scripts. Python is bounded to 512 MiB address
space and 120 CPU seconds; each extraction also has a 125-second parent timeout.
File writes are fsynced. The source whitelist is loaded with `git show` from the
exact commit. Files/directories are sealed read-only, then the canonical manifest
is fsynced and verified. No timestamp or host staging path enters its digest.

Failure leaves the new tree **unpublished** for inspection; the builder never
deletes a caller-selected directory or changes the active configuration. A
successful return supplies the exact manifest digest for separate protected
configuration review. It does not activate the package.

Browser archive hashes and usable base-image libraries remain external verified
inputs. Browser revision overrides or a different supported Linux platform need
an explicit recipe/validator revision; do not guess revisions or mark a missing
browser as ready. Disk/inode footprint, build peak and runtime compatibility
must be measured by the authorized operator, not inferred from these manifests.
