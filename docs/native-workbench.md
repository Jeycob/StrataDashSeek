# Native code editor, settings and containers

The Native `files` tab, Ctrl+Alt+P and the folder button in the Native document
preview open Code OSS through code-server for that tab's independent project.
The primary Changes and Workspace files views now share this editor. The rc.2 preview
button bridge is limited to `data-files-navigator-toggle` and obtains its target
from the official `sidebarRight.commandTarget` API. It does not infer a session
from DOM text or rewrite the immutable session header.

The separate `workspace/native-files.mjs` Host plugin uses the official Typert
`workspaceFileScope` resolver configuration. It preserves session authorization,
wire declarations and the Native file service's containment checks. Relative
file previews, mentions and new directory changefeeds resolve against the same
managed project. Live and cold sessions work without starting an LLM turn.
Unreadable or malformed managed registry state fails closed.

The original SDK inline tree still uses the original header directory. The
standard folder action routes to the integrated code editor to avoid that
SDK limitation. Explicit absolute file reads remain absolute. Existing watches
retain their original generation; reopen a watch after changing a project root.

The editor requires provisioned images, verified guest isolation, transport and
a permanently assigned separate HTTPS origin. Missing prerequisites report
unavailable while retaining project files. Source installation alone does not
establish readiness. A generation-bound one-use grant opens the browser; Native
owner credentials never enter the editor process. Mutual TLS binds its private
bridge to that generation. Authenticated client activity can renew the
five-minute idle lease, within a fixed thirty-minute generation deadline.

The client retains up to three editor contexts across conversation switches to
protect drafts. Save/conflict handling belongs to code-server. Save drafts before
switching editor windows or reconnecting expired access. On 9p-backed projects,
file-watcher polling is required for host-originated model writes. The deployed
editor still needs live-file, draft, reconnect and Safari acceptance.

Native Settings retains its original sections and adds workspace defaults,
Docker/vault/remote settings and phone notifications. The right sidebar also
shows containers, logs, start/stop and preparation from the current project.
Reading these views does not wake the Docker worker.

After the signed source and exact CI checks, activate the Host/UI additions:

```sh
node /data/harness/app/workspace/native-ui/install.cjs
```

This does not provision the editor runtime. The installer backs up the profile, preserves unrelated settings, checks for
concurrent changes, and uses an exclusive random temporary file. Activation is
additive and idempotent. Reload the client after Host configuration is ready.
Test the actual folder button and two different sessions before declaring a
production rollout complete.
