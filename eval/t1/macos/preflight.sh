#!/bin/bash
# The macOS isolation preflight's probes (#225), run as the subject user
# before any hostile input. Every probe must fail; the harness also requires
# each attempt to show up in evidence the subject cannot write (pf's log with
# the subject's uid, the logging resolver, the proxy's log), and the
# host-side listener to see no connection.
#
#   preflight.sh <host-port> <proxy-ip> <proxy-port> <api-ip> <gateway-ports,comma> <link-local-targets,comma> <link-local-ports,comma> <address>...
# Each <address> is the IPv4 gateway or a host network address. Each link-local target is an IPv6 link-local
# address with its scope (the gateway's, the host's); IPv6 is off on the uplink, so those attempts leave no
# packet and the observer counts each in the kernel's IPv6 no-route counter.
set -u
HP=$1 PIP=$2 PP=$3 API=$4 GPORTS=$5 LLT=$6 LLP=$7
shift 7
emit() { printf '{"probe":"%s","target":"%s","rc":%s,"detail":"%s"}\n' "$1" "$2" "$3" "$4"; }
tcp() { nc -z -G 3 -w 3 "$1" "$2" >/dev/null 2>&1; }
probe_tcp() { tcp "$1" "$2"; emit "${3:-tcp}" "$1:$2" $? ""; }

pids=()
for a in "$@"; do
  for port in $(printf '%s\n' "$HP" 80 443 ${GPORTS//,/ } | sort -un); do
    probe_tcp "$a" "$port" &
    pids+=($!)
  done
done
for a in 1.1.1.1 8.8.8.8; do probe_tcp "$a" 443 & pids+=($!); done
probe_tcp "$API" 443 tcp_api_direct &
pids+=($!)
wait "${pids[@]}"
# One at a time, so each attempt is one rise of the no-route counter.
for t in ${LLT//,/ }; do
  for port in $(printf '%s\n' ${LLP//,/ } | sort -un); do probe_tcp "$t" "$port" tcp_ll; done
done
pids=()
for a in "$1" 8.8.8.8; do
  ( dig +time=2 +tries=1 +short "@$a" example.com >/dev/null 2>&1; r=$?; [ "$r" = 0 ] && r=0 || r=9; emit udp "$a:53" "$r" "" ) &
  pids+=($!)
done
wait "${pids[@]}"

for n in example.com api.anthropic.com; do
  r=$(dscacheutil -q host -a name "$n" | awk '/ip_address/{print $2; exit}')
  if [ -n "$r" ]; then emit dns "$n" 0 "$r"; else emit dns "$n" 2 ""; fi
done

connect() { # target -> first status line from the proxy
  { printf 'CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n' "$1" "$1"; sleep 8; } | nc -w 10 "$PIP" "$PP" 2>/dev/null | head -1 | tr -d '\r'
}
for t in api.anthropic.com:443 example.com:443 api.anthropic.com:80 "$1:443"; do
  line=$(connect "$t"); code=$(printf '%s' "$line" | cut -d' ' -f2)
  emit proxy_connect "$t" 0 "${code:-none}"
done
line=$({ printf 'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n'; sleep 5; } | nc -w 8 "$PIP" "$PP" 2>/dev/null | head -1 | tr -d '\r')
emit proxy_get "http://example.com/" 0 "$(printf '%s' "$line" | cut -d' ' -f2)"
