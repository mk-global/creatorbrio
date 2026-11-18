# Linux environment for the sandbox network-route proof (#220).
#
# A non-root user, the same Claude CLI version as the macOS publishing host,
# and the sandbox prerequisites: bubblewrap, socat and the vendor's seccomp
# filter (shipped in @anthropic-ai/sandbox-runtime). Nothing from the host is
# mounted except the results folder, and no credential is written to the
# image: the sign-in token is passed only as an environment variable at run
# time.
#
#   docker build -t creatorbrio-sandbox-proof --build-arg CLAUDE_VERSION=2.1.327 eval/sandbox-route
#   mkdir -p -m 777 eval/results/sandbox-route
#   docker run --rm --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
#     --security-opt systempaths=unconfined -e CLAUDE_CODE_OAUTH_TOKEN \
#     -v "$PWD/eval/results/sandbox-route:/home/prover/results" creatorbrio-sandbox-proof
#
# Run these from the repository root. The run prints each arm's validity, route
# verdict, containment findings and untested probes, and writes results.json
# into the bind-mounted folder. Always mount the repository's ignored folder
# eval/results/ (see .gitignore), never a folder in the checkout that Git does
# not ignore, so a result never reaches a commit. The folder must exist and be
# writable by the container's user, hence the permissive mode on the folder made
# beforehand; once the results are copied elsewhere, delete the folder or reset
# its mode. Use --rm with a bind mount and do not copy results out of a stopped
# container: a stopped container keeps its configuration, and the sign-in token
# is part of it.
#
# The variant without the vendor's separately installed seccomp package
# overrides the entrypoint: it uninstalls @anthropic-ai/sandbox-runtime, stops
# if any seccomp helper file remains on the filesystem (a check by filename; the
# shared libseccomp library is not one), and runs only three arms. It writes to the
# same mounted folder.
#
#   docker run --rm --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
#     --security-opt systempaths=unconfined -e CLAUDE_CODE_OAUTH_TOKEN \
#     -v "$PWD/eval/results/sandbox-route:/home/prover/results" --entrypoint bash creatorbrio-sandbox-proof -c '
#       npm uninstall -g @anthropic-ai/sandbox-runtime &&
#       left=$(find / -xdev -iname "*seccomp*" ! -iname "libseccomp*" ! -path "/proc/*" 2>/dev/null) &&
#       { [ -z "$left" ] || { echo "a seccomp helper remains: $left"; exit 1; }; } &&
#       exec node --no-warnings /home/prover/proof/proof.ts --out /home/prover/results \
#         --arms control,candidate,hardened'
#
# The three --security-opt flags relax Docker's own confinement of the
# container so that bubblewrap can create its namespaces and mount /proc, as
# on an ordinary Linux host; the sandbox inside runs at full strength, never
# in its weaker nested mode.
FROM node:24-bookworm-slim

ARG CLAUDE_VERSION=2.1.327
ARG SANDBOX_RUNTIME_VERSION=0.0.81

RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap socat curl ca-certificates procps dnsutils bash \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash prover
USER prover
WORKDIR /home/prover

ENV NPM_CONFIG_PREFIX=/home/prover/.npm-global
ENV PATH=/home/prover/.local/bin:/home/prover/.npm-global/bin:$PATH

RUN curl -fsSL https://claude.ai/install.sh | bash -s "$CLAUDE_VERSION" \
  && npm install -g "@anthropic-ai/sandbox-runtime@$SANDBOX_RUNTIME_VERSION"

COPY --chown=prover:prover probe.sh proof.ts /home/prover/proof/

ENTRYPOINT ["node", "--no-warnings", "/home/prover/proof/proof.ts", "--out", "/home/prover/results"]
