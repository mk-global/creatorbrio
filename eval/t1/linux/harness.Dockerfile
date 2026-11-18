# The T1 harness services (#225): egress proxy, logging resolver, hostile
# web server and sink, canary listeners, and the observer with the driver.
# Each runs as root in its own container; none is ever the subject.
# Built by eval/t1/run.ts with eval/t1 as the context.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends tcpdump inotify-tools iproute2 openssl procps \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/t1 /run/t1

COPY register.mjs /t1/register.mjs
COPY lib /t1/lib
COPY services /t1/services

ENTRYPOINT ["node", "--no-warnings", "--import", "/t1/register.mjs"]
