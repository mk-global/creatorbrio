# The T1 subject (#225): a fresh CreatorBrio build from `git archive` of the
# harness's commit, the pinned Claude CLI, and the tools an ordinary Linux
# developer machine has. Nothing from the host is copied except that archive;
# no data, uploads, settings or credentials. The sign-in token, when a run has
# one, reaches only the running container's environment, never this image.
#
# Built by eval/t1/run.ts from a scratch context holding app.tar and the two
# scripts beside this file. Debian 12; the CLI version matches the macOS golden
# image (and the pilot's), and is installed from a tarball whose SHA-512 is
# pinned below, not from a live installer script.
FROM node:22-bookworm-slim

ARG CLAUDE_VERSION=2.1.328
# The registry's integrity value for @anthropic-ai/claude-code@2.1.328, checked against the downloaded tarball before it is installed.
ARG CLAUDE_INTEGRITY=sha512-QJTDDUhzx2Wtnoone+TULvhtxqX9KhUpgt4S96Y2eyohtZK41LWXwe7fWXcR1JnT0Ujs3AfpPTk5BZgwCyZ8pw==

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates curl git procps iproute2 netcat-openbsd dnsutils python3 \
       dbus dbus-user-session gnome-keyring libsecret-tools \
       chromium fonts-liberation \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/bash designer

# The CLI in a root-owned prefix outside the subject's writable home: it can run it, never replace it. Its package's own dependencies (the
# platform binary) are resolved by npm from the registry with the registry's integrity values; the binary's hash is recorded.
RUN set -eu; \
    mkdir -p /opt/t1 && cd /opt/t1 && npm pack "@anthropic-ai/claude-code@${CLAUDE_VERSION}" --silent >/dev/null; \
    tgz=$(ls /opt/t1/anthropic-ai-claude-code-*.tgz); \
    got="sha512-$(node -e 'const c=require("crypto"),fs=require("fs");process.stdout.write(c.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64"))' "$tgz")"; \
    [ "$got" = "$CLAUDE_INTEGRITY" ] || { echo "the Claude CLI tarball does not match its pinned integrity" >&2; exit 1; }; \
    npm install --global --prefix /opt/t1/claude --no-fund --no-audit "$tgz" >/dev/null; \
    rm -f "$tgz"; \
    real=$(readlink -f /opt/t1/claude/bin/claude); \
    [ "$(/opt/t1/claude/bin/claude --version | cut -d' ' -f1)" = "$CLAUDE_VERSION" ]; \
    printf '{"version":"%s","tarballIntegrity":"%s","binarySha256":"%s","install":"npm pack, pinned integrity, root-owned prefix"}\n' "$CLAUDE_VERSION" "$CLAUDE_INTEGRITY" "$(sha256sum "$real" | cut -d' ' -f1)" >/opt/t1/claude-provenance.json; \
    chown -R root:root /opt/t1; chmod -R go-w /opt/t1; npm cache clean --force >/dev/null 2>&1
ENV PATH=/opt/t1/claude/bin:$PATH

USER root
ADD app.tar /app/
RUN chown -R designer:designer /app
COPY subject-entry.sh plant.sh /usr/local/lib/t1/
RUN chmod 755 /usr/local/lib/t1/subject-entry.sh /usr/local/lib/t1/plant.sh

USER designer
WORKDIR /app
# Puppeteer publishes no Chrome for Linux on arm64, so export uses Debian's
# Chromium; scripts/setup.mjs would stop at that download, so its steps are
# done here instead: dependencies without install scripts, then the build.
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NEXT_TELEMETRY_DISABLED=1
RUN npm ci --ignore-scripts --no-audit --no-fund \
  && npm run build \
  && npm cache clean --force

ENTRYPOINT ["/usr/local/lib/t1/subject-entry.sh"]
