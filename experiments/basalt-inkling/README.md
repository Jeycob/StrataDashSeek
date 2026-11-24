# Inkling 2 Mini in DeepSeek Harness

This branch runs the repository's pinned DeepSeek Harness web app with Inkling 2 Mini on a separate Vast.ai instance. The inference engine is Basalt 0.5.7. The browser talks to Harness, which sends its model requests to Basalt's OpenAI-compatible endpoint on the same machine. Both services listen on loopback.

```text
Browser ── SSH tunnel ──► DeepSeek Harness :8787 ──► Basalt :8080 ──► Inkling 2 Mini
                               │                                        │
                               └── projects and sessions                └── Blackwell GPU + host RAM
```

## Choose the instance

For a low-cost trial, look for **one RTX 5060 Ti 16 GB**, approximately **32 GB host RAM**, and **60 GB disk**. At 128K context some experts on a 16 GB card run in host RAM, so the CPU and memory bandwidth matter. An **RTX PRO 4000 Blackwell 24 GB** gives the model more room. Check the exact GPU name when renting. The existing HomeAI RTX A4000 is Ampere.

Use x86-64 Linux with AVX2, NVIDIA compute capability **12.0**, driver **580.95.05 or newer**, and CUDA 13 runtime libraries including cuBLAS inside the container. Choose an SSH-capable CUDA 13 image. The prebuilt Basalt package also needs Python 3.10+ with `venv`. For Harness, install Node.js 24.9 or newer in the 24.x series with npm. The commands below use Bash, Git, curl, GNU coreutils and `flock`.

The pinned model download is approximately **19.6 GB** and includes the image encoder and speculative decoder. Disk and transfer can be billed separately from GPU time. [Basalt platform requirements](https://github.com/jesdga95/basalt/blob/v0.5.7/docs/platforms.md) · [Inkling pack and memory layout](https://github.com/jesdga95/basalt/blob/v0.5.7/docs/models/inkling2.md)

## Start the lab

Use an ordinary Linux user with a writable home on the new instance. If your SSH template logs in as root, create a dedicated user first (on Ubuntu, `useradd --create-home --shell /bin/bash basaltlab` then `su - basaltlab`). Make sure Node, npm and the CUDA libraries are available under that account. The lab stores its files under `~/.local/share/homeai-basalt-inkling`. To use an instance disk mounted elsewhere, set `BASALT_LAB_HOME` to a private writable directory on that disk in both terminals.

```bash
git clone --branch codex/basalt-inkling-blackwell --single-branch \
  https://github.com/Jeycob/StrataDashSeek.git
cd StrataDashSeek
bash experiments/basalt-inkling/engine.sh install
bash experiments/basalt-inkling/harness.sh setup
bash experiments/basalt-inkling/engine.sh serve
```

Leave Basalt running. In a second terminal on the same instance, as the same user:

```bash
cd ~/StrataDashSeek
curl --fail http://127.0.0.1:8080/v1/models
bash experiments/basalt-inkling/harness.sh
```

Wait for `inkling-2-mini` to be loaded before starting Harness. The launcher checks this ID, support for image input and the context actually served. The profile defaults to low reasoning effort and allows up to 8,192 output tokens per model response. To inspect the composed SDK profile before starting the web app, run `bash experiments/basalt-inkling/harness.sh config`. The lab keeps its Native sessions in a separate home and opens projects under `$BASALT_LAB_HOME/projects`. Remote access uses the SSH tunnel below.

For a transfer from a verified lab commit, the following archive retains the launcher, the SDK dependency lock and the shared output-continuation plugin. Extract it into a fresh directory on the instance and run the same setup and launch commands from that directory. Keep the extracted files in place while Harness runs.

```bash
git archive --format=tar -o basalt-lab.tar "$LAB_COMMIT" \
  experiments/basalt-inkling runtime/package.json runtime/package-lock.json runtime/require.cjs runtime/output-continuation
```

On your computer, add a port forward to the SSH connection shown by Vast. For example, replace the two placeholders with the SSH port and host for the test instance:

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8787:127.0.0.1:8787 -p PORT root@HOST
```

Open the private startup URL printed by Harness through that tunnel, keeping its path and any pairing parameters. The browser address uses `127.0.0.1:8787`. Keep the authenticated URL private. To end the run, stop Harness and Basalt with Ctrl+C in their terminals. Stop the rental in Vast when finished. [Vast SSH connections](https://docs.vast.ai/guides/instances/connect/ssh)

## Resume the Andorra lab after a Vast start

The enrolled Andorra instance keeps its Inkling weights, Native projects and Tailscale identity on the rental disk. Its owner opens `/pair/` on the private `basalt-inkling` node. The external wake portal probes `/phone/icon.png`. That route returns a small uncached PNG when Native accepts HTTP and Inkling reports `loaded`. The probe makes no inference request.

On the existing SSH rental, install these files from a verified root-owned release directory as root. The installer preserves the original `/root/onstart.sh`, the two established private Serve routes and the current Native profile. For the first activation, invoke the installed boot script once. Vast invokes it on subsequent starts.

```bash
python3 -I experiments/basalt-inkling/install-cold-boot.py
python3 -I /usr/local/libexec/homeai-basalt/cold-boot.py
```

The boot script starts the enrolled Tailscale daemon, the pairing and readiness endpoints, and the existing unprivileged lab launcher. It reuses the installed model and the persisted chat data. Boot output is available under `/var/log/basalt-lab-control`. The private SSH setup above remains available. [Vast instance lifecycle](https://docs.vast.ai/guides/reference/faq/instances)

## First acceptance check

In the lab workspace, open a new chat. Ask: **Create `sum.cjs` that prints the sum of its numeric command-line arguments. Run `node sum.cjs 19 23` and show the observed output.** Check the actual file, a tool result of `42`, and the model used for the answer. A response that only prints proposed source code does not verify the integration.

For a comparison with Qwen, repeat one existing task from the same starting files. Record time to the working result, tool steps, uncached input, cached input and output tokens. The 128K configuration is a ceiling; an ordinary short first run measures only the context it actually used.
