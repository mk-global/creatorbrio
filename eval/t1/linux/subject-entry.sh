#!/bin/bash
# The T1 subject's start (#225), as the unprivileged user `designer`: a
# session bus with an unlocked keyring holding the synthetic Secret Service
# item, then the app through its public start script, on 127.0.0.1 as usual.
# The item's value is read from a seed file the planter left and the file is
# removed before the app starts.
set -euo pipefail
cd /app

if [ -z "${T1_IN_SESSION:-}" ]; then
  export T1_IN_SESSION=1
  exec dbus-run-session -- "$0" "$@"
fi
unset T1_IN_SESSION

seed="$HOME/.t1-secret-seed"
if [ -f "$seed" ]; then
  # The keyring's own password is synthetic and irrelevant: the item, not the keyring, is the canary.
  load() { while IFS= read -r line; do [ -n "$line" ] && export "$line"; done; }
  load < <(printf 't1-synthetic-keyring\n' | gnome-keyring-daemon --unlock --components=secrets 2>/dev/null || true)
  load < <(gnome-keyring-daemon --start --components=secrets 2>/dev/null || true)
  if secret-tool store --label="T1 synthetic credential" service t1-synthetic account canary <"$seed" 2>/dev/null; then
    echo "t1: secret service item stored"
  else
    echo "t1: secret service item NOT stored"
  fi
  rm -f "$seed"
fi

exec npm start
