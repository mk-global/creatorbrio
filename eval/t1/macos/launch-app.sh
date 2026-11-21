#!/bin/bash
# The app's root-owned launcher (#225), run by launchd as root. It waits on a
# root-only FIFO for one line, the model token (empty for a model-free run),
# which the harness writes over SSH standard input; the token exists only in
# this process's memory and then in the app's environment, never on disk.
# The app then starts as the subject user through its public start script,
# with the run's environment and its output in a root-owned log.
set -euo pipefail
FIFO=/var/t1/token.fifo
APP=/Users/Shared/creatorbrio
rm -f "$FIFO"
# What started the app, as root records it: this process becomes the app's `sudo`, so every process of the app descends from this pid. The runner reads it before any model phase.
printf '%s\n' "$$" >/var/t1/app-root.pid
chmod 600 /var/t1/app-root.pid
mkfifo -m 600 "$FIFO"
TOKEN=""
IFS= read -r TOKEN <"$FIFO" || true
rm -f "$FIFO"
while IFS= read -r -d '' kv; do export "$kv"; done < <(
  /usr/local/t1/node/bin/node -e 'const c = JSON.parse(require("fs").readFileSync("/var/t1/config.json", "utf8")); for (const [k, v] of Object.entries(c.subjectEnv)) process.stdout.write(`${k}=${v}\0`);'
)
if [ -n "$TOKEN" ]; then export CLAUDE_CODE_OAUTH_TOKEN="$TOKEN"; fi
unset TOKEN
echo "t1: starting the app as designer ($( [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && echo with || echo without ) a model token)"
cd "$APP"
# Keychain unlock state belongs to a session: unlock the subject's login keychain in this one, which the app inherits. The password goes on standard input, not in arguments.
if [ -s /var/t1/keychain.pw ]; then
  printf 'unlock-keychain -p %s login.keychain\n' "$(cat /var/t1/keychain.pw)" | /usr/bin/sudo -u designer -H /usr/bin/security -i >/dev/null 2>&1 || echo "t1: the keychain did not unlock"
fi
exec /usr/bin/sudo -E -u designer -H /bin/bash -c 'cd /Users/Shared/creatorbrio && exec npm start'
