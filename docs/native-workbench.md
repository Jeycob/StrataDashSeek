# Native project files, settings and containers

The Native `files` tab, Ctrl+Alt+P and the folder button in the Native document
preview open the isolated project of that tab's session. The rc.2 preview
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
standard folder action routes to the integrated project browser to avoid that
SDK limitation. Explicit absolute file reads remain absolute. Existing watches
retain their original generation; reopen a watch after changing a project root.

The integrated browser supports project-specific open/edit/upload and versioned
delete. Use Refresh to reload directory entries; automatic tree synchronization
is not claimed. Refresh preserves unsaved editor content. Two sessions keep
separate targets and editor state.

Native Settings retains its original sections and adds workspace defaults,
Docker/vault/remote settings and phone notifications. The right sidebar also
shows containers, logs, start/stop and preparation from the current project.
Reading these views does not wake the Docker worker.

After copying the checked source and browser bundle, activate both additions:

```sh
node /data/harness/app/workspace/native-ui/install.cjs
```

The installer backs up the profile, preserves unrelated settings, checks for
concurrent changes, and uses an exclusive random temporary file. Activation is
additive and idempotent. Reload the client after Host configuration is ready.
Test the actual folder button and two different sessions before declaring a
production rollout complete.
