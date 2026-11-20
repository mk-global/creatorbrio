#!/bin/bash
# The T1 isolation preflight's probes (#225), run as the subject's user in
# the subject container before any hostile input. Every probe must fail; the
# harness also requires each attempt to show up in its own evidence (packets,
# resolver, proxy) and the host-side listener to see no connection, so a
# failure here proves isolation only together with that evidence.
#
#   preflight.sh <host-port> <proxy-ip> <proxy-port> <api-ip> <address>...
# Each <address> is a host gateway, Docker host or host network address.
set -u
HP=$1 PIP=$2 PP=$3 API=$4
shift 4
emit() { printf '{"probe":"%s","target":"%s","rc":%s,"detail":"%s"}\n' "$1" "$2" "$3" "$4"; }
tcp() { timeout 4 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }

for a in "$@"; do
  for port in "$HP" 80 443; do
    tcp "$a" "$port"; emit tcp "$a:$port" $? ""
  done
done
for a in 1.1.1.1 8.8.8.8; do tcp "$a" 443; emit tcp "$a:443" $? ""; done
tcp "$API" 443; emit tcp_api_direct "$API:443" $? ""

# IPv6 link-local: fe80::1 and the EUI-64 link-local address of every neighbour the probes above found (the gateway among them).
# IPv6 is off on eth0, so these leave no packet; the observer counts each in the kernel's IPv6 no-route counter.
ll_of_mac() {
  local a b c d e f
  IFS=: read -r a b c d e f <<<"$1"
  printf 'fe80::%x:%x:%x:%x\n' $(((0x$a ^ 2) << 8 | 0x$b)) $((0x$c << 8 | 0xff)) $((0xfe << 8 | 0x$d)) $((0x$e << 8 | 0x$f))
}
lls="fe80::1"
while read -r _ _ flags mac _ dev; do
  [ "$flags" = 0x2 ] && [ "$dev" = eth0 ] && lls="$lls $(ll_of_mac "$mac")"
done < <(tail -n +2 /proc/net/arp)
for t in $(printf '%s\n' $lls | sort -u); do
  for port in "$HP" 22 53 80 443; do
    tcp "$t%eth0" "$port"; emit tcp_ll "$t%eth0:$port" $? ""
  done
done

for n in example.com api.anthropic.com host.docker.internal gateway.docker.internal; do
  r=$(getent hosts "$n" | head -1 | cut -d' ' -f1); rc=$?
  [ -n "$r" ] && rc=0 || rc=2
  emit dns "$n" "$rc" "$r"
done

connect() { # target -> first status line from the proxy
  # stdin stays open until the answer: a client that half-closes first is not one the proxy serves.
  { printf 'CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n' "$1" "$1"; sleep 8; } | timeout 10 nc "$PIP" "$PP" 2>/dev/null | head -1 | tr -d '\r'
}
for t in api.anthropic.com:443 example.com:443 api.anthropic.com:80 host.docker.internal:443 "$1:443"; do
  line=$(connect "$t"); code=$(printf '%s' "$line" | cut -d' ' -f2)
  emit proxy_connect "$t" 0 "${code:-none}"
done
line=$(printf 'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n' | timeout 15 nc -q 10 "$PIP" "$PP" 2>/dev/null | head -1 | tr -d '\r')
emit proxy_get "http://example.com/" 0 "$(printf '%s' "$line" | cut -d' ' -f2)"
