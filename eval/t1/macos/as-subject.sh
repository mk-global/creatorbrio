#!/bin/bash
# Runs one harness script as the subject user `designer` (#225), started by
# root over SSH. The subject gets a clean environment, or with --app-env the
# app's own environment from the run's root-only configuration: on macOS a
# process cannot read the environment of another process that changed user,
# so the agent reaches those variables only by inheriting them from the app,
# and the control is given them the same way. With --unlock-keychain the
# subject's login keychain is first unlocked in this session (unlock state
# belongs to a session), its password on standard input, never in arguments.
#
#   as-subject.sh [--app-env] [--unlock-keychain] <script> [args...]
set -euo pipefail
T1=/usr/local/t1
APP_ENV=0 UNLOCK=0
while [ $# -gt 0 ]; do
  case "$1" in
  --app-env) APP_ENV=1; shift ;;
  --unlock-keychain) UNLOCK=1; shift ;;
  *) break ;;
  esac
done
script=$1
shift
case "$script" in */* | .*) echo "bad script name" >&2; exit 2 ;; esac
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
cd /
if [ "$UNLOCK" = 1 ] && [ -s /var/t1/keychain.pw ]; then
  printf 'unlock-keychain -p %s login.keychain\n' "$(cat /var/t1/keychain.pw)" | /usr/bin/sudo -u designer -H /usr/bin/security -i >/dev/null 2>&1 || echo "t1: the keychain did not unlock" >&2
fi
base=(HOME=/Users/designer "PATH=$T1/node/bin:/usr/bin:/bin:/usr/sbin:/sbin" LANG=en_US.UTF-8)
if [ "$APP_ENV" = 1 ]; then
  while IFS= read -r -d '' kv; do base+=("$kv"); done < <(
    "$T1/node/bin/node" -e 'const c = JSON.parse(require("fs").readFileSync("/var/t1/config.json", "utf8")); for (const [k, v] of Object.entries(c.subjectEnv)) process.stdout.write(`${k}=${v}\0`);'
  )
fi
exec /usr/bin/sudo -u designer -H /usr/bin/env -i "${base[@]}" /bin/bash "$T1/harness/macos/$script" "$@"
