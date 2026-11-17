# syntax=docker/dockerfile:1.27.1@sha256:7b32114e84ca21aeb2d6f871a0b62b3a0762193f75d9afd048ee4cbe889f3148
# SOURCE ONLY: packages/ is an explicit, separately acquired public input set.
FROM --platform=linux/amd64 docker.io/library/debian@sha256:7378260c0a098d27ac206225db5e7d92b8c7c84ea7afccc86eeb513756bbd392
COPY os-packages.lock.tsv install-offline.sh /usr/local/lib/homeai-os-base/
RUN --network=none --mount=type=bind,source=packages,target=/locked-packages,ro \
    echo 'd300e2711c0ed3d53842428e457294d0f873ef613e8f70a13fee430c2535ca59  /usr/local/lib/homeai-os-base/os-packages.lock.tsv' | sha256sum -c - && \
    /bin/sh /usr/local/lib/homeai-os-base/install-offline.sh /locked-packages --install
RUN --network=none groupadd --gid 1001 coder && \
    useradd --uid 1001 --gid 1001 --home-dir /home/coder --shell /bin/bash --no-create-home coder && \
    mkdir -p /opt/code-server /opt/homeai /opt/dotnet /opt/playwright /opt/npm /workspace /home/coder /etc/homeai && \
    chmod 0555 /opt/code-server /opt/homeai /opt/dotnet /opt/playwright /opt/npm && \
    chown 1001:1001 /home/coder /workspace
COPY code-server.yaml /etc/homeai/code-server.yaml
ENV HOME=/home/coder USER=coder LANG=C.UTF-8
USER 1001:1001
WORKDIR /workspace
# Managed policy supplies the exact role entrypoint and RO T bind grants.
