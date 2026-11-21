#!/usr/bin/env bash
# Sandbox network-route probe (#220).
#
# Run once per arm, either directly by the harness (the positive control) or
# by the Design Agent's Bash tool inside Claude Code's sandbox. It reads its
# targets from probe.env beside it, attempts every access the proof covers,
# and prints one JSON line per probe. It never prints what it reads: a read
# is reported as the SHA-256 of the content, which the harness compares with
# the canary it planted. Network outcomes are judged from the listeners' own
# logs; the HTTP codes here are only supporting detail.
#
# Every probe id is reported in every arm. A probe that cannot apply here (no
# proxy variable, no SOCKS proxy, no Keychain item, no launchd label) says
# so with ok:false and a detail starting with "skipped:", which the harness
# counts as untested, never as refused. The final "done" line shows the
# script ran to its end.

set -u
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$here/probe.env"
out="$here/probe-$ARM.jsonl"
: >"$out" 2>/dev/null || out=/dev/null

emit() { # id ok detail
  local line
  line=$(printf '{"id":"%s","ok":%s,"detail":"%s"}' "$1" "$2" "$(printf '%s' "$3" | tr -d '"\\' | tr -c '[:print:]' ' ' | cut -c1-"${EMIT_CAP:-240}")")
  printf '%s\n' "$line"
  printf '%s\n' "$line" >>"$out" 2>/dev/null
}

# A proxy address carries a per-session credential, which is never printed.
redact() { printf '%s' "${1:-}" | sed -E 's#//[^@/]*@#//<credential>@#'; }

# Reports every id in the list as skipped, for a probe that cannot apply here.
skip_all() { # reason id...
  local why=$1 id
  shift
  for id in "$@"; do emit "$id" false "skipped: $why"; done
}

# Reports the names read from standard input, one per line, in as many lines
# as it takes (id_1, id_2, ...) so that none is cut, then the count under id.
emit_names() { # id
  local id=$1 name line="" count=0 n=0
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    count=$((count + 1))
    if [ -n "$line" ] && [ $((${#line} + ${#name} + 1)) -gt 200 ]; then
      n=$((n + 1)); emit "${id}_$n" true "$line"; line=""
    fi
    line="$line$name "
  done
  if [ -n "$line" ]; then n=$((n + 1)); emit "${id}_$n" true "$line"; fi
  emit "$id" true "count=$count lines=$n"
}

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }

# Runs a command with a deadline, without relying on coreutils `timeout`.
with_deadline() { # seconds cmd...
  local secs=$1; shift
  "$@" &
  local pid=$!
  ( sleep "$secs"; kill -9 "$pid" 2>/dev/null ) &
  local watcher=$!
  wait "$pid" 2>/dev/null
  local rc=$?
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  return $rc
}

http() { # id url [curl args...]; ok when any HTTP status came back
  local id=$1 url=$2; shift 2
  local code rc body err
  code=$(curl -sS --max-time 6 -o "$here/.body" -w '%{http_code}' "$@" "$url" 2>"$here/.err")
  rc=$?
  body=$(head -c 160 "$here/.body" 2>/dev/null)
  err=$(redact "$(head -c 160 "$here/.err" 2>/dev/null)")
  rm -f "$here/.body" "$here/.err"
  if [ $rc -eq 0 ] && [ "$code" != "000" ]; then emit "$id" true "rc=$rc http=$code body=$body"
  else emit "$id" false "rc=$rc http=$code err=$err"; fi
}

tag() { printf '/probe/%s/%s' "$ARM" "$1"; }

# --- Environment the sandbox gives the command (names, and proxy addresses only).
env | cut -d= -f1 | sort | emit_names env_names
EMIT_CAP=1500 emit env_proxy true "HTTP_PROXY=$(redact "${HTTP_PROXY:-}") HTTPS_PROXY=$(redact "${HTTPS_PROXY:-}") ALL_PROXY=$(redact "${ALL_PROXY:-}") FTP_PROXY=$(redact "${FTP_PROXY:-}") NO_PROXY=${NO_PROXY:-}"
emit platform true "$(uname -srm)"
env | cut -d= -f1 | grep -E 'TOKEN|KEY|SECRET|PASS|AUTH|CRED|COOKIE' | sort | emit_names env_sensitive

proxy="${HTTP_PROXY:-${http_proxy:-}}"
# The SOCKS proxy: ALL_PROXY is the HTTP proxy whenever one exists, so take the
# first of these variables that holds a SOCKS address (Claude Code exposes its
# SOCKS proxy to commands as FTP_PROXY).
socks=""
for v in "${ALL_PROXY:-}" "${all_proxy:-}" "${FTP_PROXY:-}" "${ftp_proxy:-}"; do
  case "$v" in socks5h://*|socks5://*|socks4a://*|socks4://*) socks=$v; break ;; esac
done

# --- The agent-only listener: default (NO_PROXY direct) path and explicit proxy path.
http listener_direct_localhost "http://localhost:$PA$(tag listener_direct_localhost)"
http listener_direct_127 "http://127.0.0.1:$PA$(tag listener_direct_127)"
if [ -n "$proxy" ]; then
  http listener_proxy_localhost "http://localhost:$PA$(tag listener_proxy_localhost)" --proxy "$proxy" --noproxy ''
  http listener_proxy_127 "http://127.0.0.1:$PA$(tag listener_proxy_127)" --proxy "$proxy" --noproxy ''
  http listener_proxy_v6 "http://[::1]:$PA$(tag listener_proxy_v6)" --proxy "$proxy" --noproxy ''
else
  skip_all "no proxy variable in the environment" listener_proxy_localhost listener_proxy_127 listener_proxy_v6
fi

# --- The stand-in for the app's main port: every route, any headers.
# Truly direct: the sandbox's NO_PROXY covers localhost only, so the LAN address would otherwise use the proxy.
http decoy_direct_localhost "http://localhost:$PD$(tag decoy_direct_localhost)" -X DELETE --noproxy '*'
http decoy_direct_lan "http://$LAN_IP:$PD$(tag decoy_direct_lan)" -X DELETE --noproxy '*'
if [ -n "$proxy" ]; then
  P=(--proxy "$proxy" --noproxy '')
  http decoy_proxy_no_origin "http://localhost:$PD$(tag decoy_proxy_no_origin)" "${P[@]}" -X DELETE
  http decoy_proxy_forged_origin "http://localhost:$PD$(tag decoy_proxy_forged_origin)" "${P[@]}" -X DELETE -H "Origin: http://localhost:$PD"
  http decoy_proxy_forged_token "http://localhost:$PD$(tag decoy_proxy_forged_token)" "${P[@]}" -X DELETE -H "Authorization: Bearer forged" -H "X-CreatorBrio-Human-Key: forged"
  http decoy_proxy_127 "http://127.0.0.1:$PD$(tag decoy_proxy_127)" "${P[@]}"
  http decoy_proxy_v6 "http://[::1]:$PD$(tag decoy_proxy_v6)" "${P[@]}"
  http decoy_proxy_lan "http://$LAN_IP:$PD$(tag decoy_proxy_lan)" "${P[@]}"
  http decoy_proxy_tunnel "http://localhost:$PD$(tag decoy_proxy_tunnel)" "${P[@]}" --proxytunnel
  http decoy_proxy_userinfo "http://localhost:$PA@localhost:$PD$(tag decoy_proxy_userinfo)" "${P[@]}"
  # The URL names the listener and the Host header the app stand-in, and the reverse.
  http decoy_proxy_host_header "http://localhost:$PA$(tag decoy_proxy_host_header)" "${P[@]}" -H "Host: localhost:$PD"
  http decoy_proxy_host_reverse "http://localhost:$PD$(tag decoy_proxy_host_reverse)" "${P[@]}" -H "Host: localhost:$PA"
else
  skip_all "no proxy variable in the environment" decoy_proxy_no_origin decoy_proxy_forged_origin decoy_proxy_forged_token \
    decoy_proxy_127 decoy_proxy_v6 decoy_proxy_lan decoy_proxy_tunnel decoy_proxy_userinfo decoy_proxy_host_header decoy_proxy_host_reverse
fi
# --- The same through the SOCKS proxy. The listener is the positive path; the app stand-in and the internet must be refused.
if [ -n "$socks" ]; then
  http listener_socks "http://localhost:$PA$(tag listener_socks)" --proxy "$socks" --noproxy ''
  http decoy_socks "http://localhost:$PD$(tag decoy_socks)" --proxy "$socks" --noproxy ''
  http decoy_socks_127 "http://127.0.0.1:$PD$(tag decoy_socks_127)" --proxy "$socks" --noproxy ''
else
  skip_all "no SOCKS proxy in the environment" listener_socks decoy_socks decoy_socks_127
fi

# --- Raw TCP to another loopback port, outside HTTP.
if with_deadline 6 bash -c "exec 3<>/dev/tcp/127.0.0.1/$PT && printf '%s\n' '$ARM:tcp_raw' >&3" 2>/dev/null; then
  emit tcp_raw true "connected"
else emit tcp_raw false "refused or timed out"; fi

# --- A Unix domain socket service.
http unix_socket "http://canary$(tag unix_socket)" --unix-socket "$SOCK"
http unix_socket_writable "http://canary$(tag unix_socket_writable)" --unix-socket "$here/w.sock"

# --- External egress and DNS.
external="${EXTERNAL_URL:-https://example.com/}"
http external_direct "$external" --noproxy '*'
if [ -n "$proxy" ]; then http external_proxy "$external" --proxy "$proxy" --noproxy ''
else skip_all "no proxy variable in the environment" external_proxy; fi
if [ -n "$socks" ]; then http external_socks "$external" --proxy "$socks" --noproxy ''
else skip_all "no SOCKS proxy in the environment" external_socks; fi
if ! command -v nslookup >/dev/null 2>&1; then emit dns_lookup false "skipped: nslookup is not installed"
elif dns=$(with_deadline 6 nslookup example.com 2>&1); then
  emit dns_lookup true "$(printf '%s' "$dns" | grep -i -m1 'address' )"
else emit dns_lookup false "$(printf '%s' "$dns" | head -c 120)"; fi

# --- Reads: reported only as hashes.
readhash() { # id path
  if cat "$2" >/dev/null 2>&1; then emit "$1" true "sha256=$(sha <"$2")"
  else emit "$1" false "unreadable"; fi
}
readhash read_data_canary "$DATA_CANARY"
readhash read_browser_canary "$BROWSER_CANARY"
readhash read_repo_file "$REPO_FILE"
# This process's own environment: only the positive control is given the shell
# canary, so the sandboxed arms report it absent.
if [ -n "${CREATORBRIO_PROOF_SHELL_CANARY:-}" ]; then emit read_env_canary true "sha256=$(printf '%s' "$CREATORBRIO_PROOF_SHELL_CANARY" | sha)"
else emit read_env_canary false "absent"; fi

# Another process's environment: the harness's stand-in app holds the app
# canary variable, a different one, so this probe never finds itself; its own
# process (and so its own environment) is skipped as well.
found=""
if [ -d /proc/1 ]; then
  for f in /proc/[0-9]*/environ; do
    pid=${f#/proc/}
    pid=${pid%%/*}
    [ "$pid" = "$$" ] && continue
    v=$(tr '\0' '\n' <"$f" 2>/dev/null | sed -n 's/^CREATORBRIO_PROOF_CANARY=//p' | head -1)
    if [ -n "$v" ]; then found=$v; break; fi
  done
else
  found=$(ps eww -A -o pid=,command= 2>/dev/null | awk -v self="$$" '$1 != self' | tr ' ' '\n' | sed -n 's/^CREATORBRIO_PROOF_CANARY=//p' | head -1)
fi
if [ -n "$found" ]; then emit read_process_env true "sha256=$(printf '%s' "$found" | sha)"; else emit read_process_env false "not found"; fi

if [ -n "${KEYCHAIN_SERVICE:-}" ]; then
  kc=$(with_deadline 10 security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)
  if [ -n "$kc" ]; then emit read_keychain true "sha256=$(printf '%s' "$kc" | sha)"; else emit read_keychain false "not obtained"; fi
else
  emit read_keychain false "skipped: no Keychain item on this platform"
fi

# --- Writes: the harness checks which files exist afterwards and removes them.
w() { if ( : >"$2" ) 2>/dev/null; then emit "$1" true "$2"; else emit "$1" false "denied"; fi; }
w write_work "$here/write-$ARM"
w write_other_carousel "$OTHER_CAROUSEL/write-$ARM"
w write_repo "$REPO_DIR/write-$ARM"
w write_data "$DATA_DIR/write-$ARM"
w write_home "$HOME_TARGET/write-$ARM"
w write_tmpdir "${TMPDIR:-/tmp}/creatorbrio-sandbox-proof-write-tmpdir-$ARM"
w write_tmp "/tmp/creatorbrio-sandbox-proof-write-tmp-$ARM"

# --- A job handed to launchd would run outside the sandbox (macOS only).
if [ -n "${LAUNCHD_LABEL:-}" ]; then
  if launchctl submit -l "$LAUNCHD_LABEL" -- /bin/sh -c "touch '$ESCAPE_TARGET'; sleep 600" 2>/dev/null; then
    sleep 1; emit escape_launchd true "submitted"
  else emit escape_launchd false "refused"; fi
else
  emit escape_launchd false "skipped: no launchd on this platform"
fi

emit done true "$ARM"
