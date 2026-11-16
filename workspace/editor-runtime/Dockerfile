# Source-only proposal: build only after the coordinator's capacity decision.
# Debian linux/amd64 manifest observed from Docker's official registry 2026-11-16.
FROM debian@sha256:7378260c0a098d27ac206225db5e7d92b8c7c84ea7afccc86eeb513756bbd392 AS unpack
COPY code-server-4.145.2-linux-amd64.tar.gz /tmp/code-server.tar.gz
RUN echo '2f6db6c3e8b733dd6b3aeee83532e148b2bae2e392353ba85452d03572348962  /tmp/code-server.tar.gz' | sha256sum -c - \
    && mkdir /code-server \
    && tar -xzf /tmp/code-server.tar.gz --strip-components=1 -C /code-server

FROM debian@sha256:7378260c0a098d27ac206225db5e7d92b8c7c84ea7afccc86eeb513756bbd392
ARG EDITOR_UID=1001
ARG EDITOR_GID=1001
# Minimal editor runtime: shell + Git + the archive's own Node 24.22.1.
# No sudo, fixuid, Docker CLI/socket, SSH keys, host toolchain or credentials.
# apt package versions and final image digest must be recorded by the builder.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git ripgrep libstdc++6 libatomic1 \
    && rm -rf /var/lib/apt/lists/* \
    && test "$EDITOR_UID" -ge 1000 && test "$EDITOR_GID" -ge 1000 \
    && groupadd -g "$EDITOR_GID" coder \
    && useradd --uid "$EDITOR_UID" --gid "$EDITOR_GID" --home-dir /home/coder --shell /bin/sh coder \
    && mkdir -p /home/coder /workspace /etc/homeai /run/homeai-editor \
    && chown "$EDITOR_UID:$EDITOR_GID" /home/coder /workspace /run/homeai-editor
COPY --from=unpack --chown=0:0 /code-server /opt/code-server
COPY --chown=0:0 code-server.yaml /etc/homeai/code-server.yaml
ENV HOME=/home/coder USER=coder LANG=C.UTF-8 \
    PATH=/opt/code-server/bin:/opt/code-server/lib:/usr/bin:/bin \
    XDG_CONFIG_HOME=/home/coder/config XDG_CACHE_HOME=/home/coder/cache \
    XDG_DATA_HOME=/home/coder/data \
    EXTENSIONS_GALLERY='{"serviceUrl":"http://127.0.0.1:9/disabled","itemUrl":"http://127.0.0.1:9/disabled"}'
USER ${EDITOR_UID}:${EDITOR_GID}
WORKDIR /workspace
ENTRYPOINT ["/opt/code-server/bin/code-server", "--config", "/etc/homeai/code-server.yaml"]
CMD ["--auth", "none", "--socket", "/run/homeai-editor/code.sock", "--socket-mode", "0600", "--disable-proxy", "--disable-telemetry", "--disable-update-check", "--disable-file-cache", "--enable-remote-storage", "--user-data-dir", "/home/coder/user-data", "--extensions-dir", "/home/coder/extensions", "--vscode-option", "file-watcher-polling=1000:/workspace", "/workspace"]
