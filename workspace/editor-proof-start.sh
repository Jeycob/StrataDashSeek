#!/bin/sh
# Local synthetic editor acceptance fixture; not a production launcher.
set -eu
EDITOR_FIXTURE=/var/tmp/homeai-editor-b-20261116
test -x "$EDITOR_FIXTURE/code-server-4.145.2-linux-amd64/bin/code-server"
mkdir -p "$EDITOR_FIXTURE/home" "$EDITOR_FIXTURE/user-data/User" "$EDITOR_FIXTURE/extensions" "$EDITOR_FIXTURE/project"
cat > "$EDITOR_FIXTURE/user-data/User/settings.json" <<'JSON'
{"files.autoSave":"off","files.hotExit":"onExitAndWindowClose","files.saveConflictResolution":"askUser","workbench.startupEditor":"none","workbench.editor.enablePreview":false,"security.workspace.trust.enabled":false,"extensions.autoCheckUpdates":false,"extensions.autoUpdate":false,"telemetry.telemetryLevel":"off","window.confirmBeforeClose":"always"}
JSON
printf 'auth: none\nbind-addr: 127.0.0.1:39311\ncert: false\n' > "$EDITOR_FIXTURE/config.yaml"
if test ! -e "$EDITOR_FIXTURE/project/.git"; then
  printf 'Original model file\n' > "$EDITOR_FIXTURE/project/example.txt"
  git -C "$EDITOR_FIXTURE/project" init -q
  git -C "$EDITOR_FIXTURE/project" add example.txt
  git -C "$EDITOR_FIXTURE/project" -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit -qm baseline
fi
exec env -i HOME="$EDITOR_FIXTURE/home" PATH=/usr/bin:/bin \
  EXTENSIONS_GALLERY='{"serviceUrl":"http://127.0.0.1:9/disabled","itemUrl":"http://127.0.0.1:9/disabled"}' \
  "$EDITOR_FIXTURE/code-server-4.145.2-linux-amd64/bin/code-server" \
  --config "$EDITOR_FIXTURE/config.yaml" --auth none --bind-addr 127.0.0.1:39311 \
  --disable-telemetry --disable-update-check --disable-proxy --disable-file-cache --enable-remote-storage \
  --user-data-dir "$EDITOR_FIXTURE/user-data" --extensions-dir "$EDITOR_FIXTURE/extensions" \
  "$EDITOR_FIXTURE/project"
