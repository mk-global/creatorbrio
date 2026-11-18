# The T1 subject (#225): a fresh CreatorBrio build from `git archive` of the
# harness's commit, the pinned Claude CLI, and the tools an ordinary Linux
# developer machine has. Nothing from the host is copied except that archive;
# no data, uploads, settings or credentials. The sign-in token, when a run has
# one, reaches only the running container's environment, never this image.
#
# Built by eval/t1/run.ts from a scratch context holding app.tar and the two
# scripts beside this file. Debian 12 and the CLI version match #220.
FROM node:22-bookworm-slim

ARG CLAUDE_VERSION=2.1.327

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates curl git procps iproute2 netcat-openbsd dnsutils python3 \
       dbus dbus-user-session gnome-keyring libsecret-tools \
       chromium fonts-liberation \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/bash designer

USER designer
WORKDIR /home/designer
ENV PATH=/home/designer/.local/bin:$PATH
RUN curl -fsSL https://claude.ai/install.sh | bash -s "$CLAUDE_VERSION"

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
